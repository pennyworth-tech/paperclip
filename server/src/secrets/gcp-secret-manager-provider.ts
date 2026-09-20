import { createHash, createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DeploymentMode, SecretProviderConfigDiscoveryPreviewResult } from "@paperclipai/shared";
import { GCP_LOCATION_RE, GCP_PROJECT_ID_RE, GCP_PROJECT_NUMBER_RE } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

const GCP_SECRET_MANAGER_SCHEME = "gcp_secret_manager_v1";
// Links created while the provider was an unconfigured stub were stored under the
// generic external-reference scheme. Those rows must keep resolving.
const LEGACY_EXTERNAL_REFERENCE_SCHEME = "external_reference_v1";
const DEFAULT_SECRET_MANAGER_ENDPOINT = "https://secretmanager.googleapis.com";
const DEFAULT_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// The link-local address is the default rather than metadata.google.internal so that
// off-GCE the probe fails on connect instead of waiting on a DNS lookup that cannot
// resolve. Overridable below, like every other endpoint in this file.
const DEFAULT_METADATA_SERVER_IP = "169.254.169.254";
const METADATA_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";
// The multi-region service. Stored as null internally: a global resource name carries
// no locations/ segment, so "global" and "unset" have to mean exactly the same thing.
const GLOBAL_LOCATION = "global";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_VERSION_ALIAS = "latest";
const GCP_REQUEST_TIMEOUT_MS = 30_000;
// Off Google Compute Engine the metadata address is unroutable, so a probe that
// waits for the default connect timeout would stall every caller behind it.
const METADATA_PROBE_TIMEOUT_MS = 2_000;
// One failed probe is enough to conclude the process is not on Google infrastructure
// for a while; without this every resolve off-GCE pays the probe timeout again.
const METADATA_UNAVAILABLE_BACKOFF_MS = 60_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
// A token handed in by configuration carries no expiry, so it is re-read from
// configuration on this cadence and a rotated value is picked up without a restart.
const STATIC_TOKEN_REFRESH_MS = 5 * 60_000;
const SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS = 3600;
const PROVIDER_CONFIG_DISCOVERY_SAMPLE_LIMIT = 3;
const PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT = 2;
const GCP_RUNTIME_CREDENTIAL_WARNING =
  "Google application default credentials must be available to the Paperclip server runtime: workload identity, a GOOGLE_APPLICATION_CREDENTIALS service-account key file, or the Compute Engine metadata server.";
// "Denied" would send an operator to the IAM console; the far more common cause of a
// failed credential acquisition is that the runtime has no credentials to present.
const GCP_CREDENTIAL_ACQUISITION_MESSAGE =
  "GCP Secret Manager credentials could not be acquired by the server runtime.";
const GCP_CREDENTIAL_CUSTODY_WARNING =
  "Do not store Google service-account keys in Paperclip company_secrets; the GCP provider bootstrap belongs in deployment infrastructure, the process environment, or the orchestrator secret store.";

function unanchored(pattern: RegExp): string {
  return pattern.source.replace(/^\^/, "").replace(/\$$/, "");
}

// Composed out of the shared project patterns the API schema validates against, so a
// project the board accepts and a project a resource name may name cannot drift apart.
const PROJECT_SEGMENT = `(?:${unanchored(GCP_PROJECT_ID_RE)}|${unanchored(GCP_PROJECT_NUMBER_RE)})`;
// Only a regional location appears in a resource name; "global" resources have no
// locations/ segment at all, which is why GCP_LOCATION_RE is not reused verbatim here.
const REGIONAL_LOCATION_SEGMENT = "[a-z]+-[a-z]+[0-9]+";
// A secret reference is interpolated into a request path, so every form is matched
// against an allowlist rather than scrubbed: traversal segments, schemes and hosts
// cannot survive these character classes. Listing returns resource names carrying the
// project number, so the numeric project form has to be accepted alongside the id.
const FULL_SECRET_REF_RE = new RegExp(
  `^projects/(${PROJECT_SEGMENT})(?:/locations/(${REGIONAL_LOCATION_SEGMENT}))?` +
    "/secrets/([A-Za-z0-9_-]{1,255})$",
);
const BARE_SECRET_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const VERSION_REF_RE = /^(?:latest|[1-9][0-9]{0,18})$/;

function isProjectRef(value: string): boolean {
  return GCP_PROJECT_ID_RE.test(value) || GCP_PROJECT_NUMBER_RE.test(value);
}

interface GcpSecretManagerConfig {
  projectId: string;
  /** null means the global (multi-region) service; otherwise a regional endpoint. */
  location: string | null;
  endpoint: string;
}

interface GcpSecretManagerMaterial extends StoredSecretVersionMaterial {
  scheme: typeof GCP_SECRET_MANAGER_SCHEME;
  externalRef: string;
  providerVersionRef: string | null;
  source: "external_reference";
}

interface GcpSecretRef {
  projectId: string;
  location: string | null;
  secretId: string;
}

interface GcpAccessToken {
  accessToken: string;
  /** Absolute expiry in epoch milliseconds; the provider refreshes ahead of it. */
  expiresAtMs: number;
}

/**
 * The seam that keeps credential acquisition out of the request path in tests.
 * Only `fetchAccessToken` is required: caching, refresh and error mapping belong to
 * the provider, not to the source.
 */
export interface GcpTokenSource {
  fetchAccessToken(): Promise<GcpAccessToken>;
  /** Synchronous, network-free signal for `descriptor().configured`. */
  hasDetectedCredentials?(): boolean;
  /** Operator-facing label for the credential path. Never the token itself. */
  describe?(): string;
  /** The project the credentials themselves imply, when they carry one. */
  resolveProjectId?(): Promise<string | null>;
}

interface GcpSecretEntry {
  name?: string;
  createTime?: string;
  expireTime?: string;
  labels?: Record<string, string>;
}

/**
 * The seam that keeps the Secret Manager REST surface out of the provider logic, so the
 * reference parsing, tenancy and error-mapping rules can be tested without a transport.
 * Requests are already validated and scoped when they arrive here: `projectId` and
 * `location` are the vault's own, never a caller's. `listSecrets` is optional because a
 * least-privilege deployment may hold versions.access without secrets.list, and
 * resolution must keep working for it.
 */
export interface GcpSecretManagerGateway {
  accessSecretVersion(input: {
    projectId: string;
    /** null for the global service; a region for a regional vault. */
    location: string | null;
    secretId: string;
    version: string;
  }): Promise<{ payload?: { data?: string } }>;
  listSecrets?(input: {
    projectId: string;
    location: string | null;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ secrets?: GcpSecretEntry[]; nextPageToken?: string }>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function base64Url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

function resolveEnvProjectId(): string | null {
  return (
    asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_GCP_PROJECT_ID) ??
    asOptionalNonEmptyString(process.env.GOOGLE_CLOUD_PROJECT) ??
    asOptionalNonEmptyString(process.env.GCLOUD_PROJECT)
  );
}

/**
 * Regional vaults must talk to the regional endpoint: a regional secret is simply not
 * visible through the global one. An explicit endpoint override still wins, because it
 * exists for proxies and emulators that front whichever service the deployment uses.
 */
function resolveEndpoint(location: string | null): string {
  const override = asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_GCP_ENDPOINT);
  if (override) return override.replace(/\/+$/, "");
  if (location) return `https://secretmanager.${location}.rep.googleapis.com`;
  return DEFAULT_SECRET_MANAGER_ENDPOINT;
}

/**
 * google-auth-library honours GCE_METADATA_HOST (a host, optionally with a port) and
 * GCE_METADATA_IP, so a runtime behind an emulator or a non-default metadata address
 * works without patching this file.
 */
function resolveMetadataOrigin(): string {
  const host =
    asOptionalNonEmptyString(process.env.GCE_METADATA_HOST) ??
    asOptionalNonEmptyString(process.env.GCE_METADATA_IP) ??
    DEFAULT_METADATA_SERVER_IP;
  const origin = /^https?:\/\//i.test(host) ? host : `http://${host}`;
  return origin.replace(/\/+$/, "");
}

// Environment markers that only Google's own hosted runtimes set. They are how a
// metadata-only runtime is recognised without a network probe, which `descriptor()`
// cannot make because it is synchronous.
const HOSTED_GCP_RUNTIME_ENV_KEYS = [
  "K_SERVICE",
  "K_REVISION",
  "CLOUD_RUN_JOB",
  "FUNCTION_TARGET",
  "GAE_ENV",
  "GAE_SERVICE",
  // Not Google-set markers, but an operator who points the runtime at a metadata
  // server address has stated that one is reachable. Both, to match what
  // google-auth-library reads and what `paperclipai doctor` counts as a credential source.
  "GCE_METADATA_HOST",
  "GCE_METADATA_IP",
] as const;

function hasHostedGcpRuntimeMarker(): boolean {
  return HOSTED_GCP_RUNTIME_ENV_KEYS.some((key) =>
    Boolean(asOptionalNonEmptyString(process.env[key])),
  );
}

function normalizeLocation(value: string | null): string | null {
  if (!value || value === GLOBAL_LOCATION) return null;
  return value;
}

/**
 * The canonical spelling of a reference inside a vault: the vault's own project and
 * location, exactly as the vault config writes them. Every reference Paperclip emits or
 * stores uses this form, which is what lets the tenancy check be a plain comparison.
 */
function canonicalSecretRef(config: GcpSecretManagerConfig, secretId: string): string {
  const parent = config.location
    ? `projects/${config.projectId}/locations/${config.location}`
    : `projects/${config.projectId}`;
  return `${parent}/secrets/${secretId}`;
}

function resolveStaticAccessToken(): string | null {
  return asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_GCP_ACCESS_TOKEN);
}

function resolveServiceAccountKeyPath(): string | null {
  return asOptionalNonEmptyString(process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

function classifyGcpProviderError(message: string): SecretProviderClientErrorCode {
  // Canonical status names are matched before numeric codes: resource paths and
  // project numbers in an error body routinely contain digit runs.
  if (/ALREADY_EXISTS/i.test(message)) return "conflict";
  if (/NOT_FOUND/i.test(message)) return "not_found";
  if (/PERMISSION_DENIED|UNAUTHENTICATED|credentials?\b.*(unavailable|missing|invalid)/i.test(message)) {
    return "access_denied";
  }
  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) return "throttled";
  if (/INVALID_ARGUMENT|FAILED_PRECONDITION|OUT_OF_RANGE/i.test(message)) return "invalid_request";
  if (/UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/i.test(message)) return "provider_unavailable";
  if (/\b409\b/.test(message)) return "conflict";
  if (/\b404\b/.test(message)) return "not_found";
  if (/\b401\b|\b403\b/.test(message)) return "access_denied";
  if (/\b429\b/.test(message)) return "throttled";
  if (/\b400\b/.test(message)) return "invalid_request";
  if (/\b5\d{2}\b/.test(message)) return "provider_unavailable";
  if (/fetch failed|ECONN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|abort|network|timeout/i.test(message)) {
    return "provider_unavailable";
  }
  return "provider_error";
}

function gcpProviderSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied":
      return "GCP Secret Manager denied the request. Check the IAM bindings for this provider vault.";
    case "throttled":
      return "GCP Secret Manager throttled the request. Wait and try again.";
    case "not_found":
      return "GCP Secret Manager could not find the requested secret.";
    case "conflict":
      return "GCP Secret Manager reported that the requested secret already exists.";
    case "invalid_request":
      return "GCP Secret Manager rejected the request.";
    case "provider_unavailable":
      return "GCP Secret Manager is unavailable right now.";
    case "provider_error":
    default:
      return "GCP Secret Manager request failed.";
  }
}

/**
 * Google error bodies echo the full resource path and often the caller identity, so
 * only the generic message reaches the operator; the raw text stays in `rawMessage`.
 */
function normalizeGcpError(operation: string, error: unknown): never {
  // An error raised below already carries a safe message and a precise code;
  // re-classifying its redacted text would degrade both. Only the operation is
  // restated, so the caller sees the provider call it made rather than the transport one.
  if (error instanceof SecretProviderClientError) {
    throw new SecretProviderClientError({
      code: error.code,
      provider: "gcp_secret_manager",
      operation,
      message: error.message,
      status: error.status,
      rawMessage: error.rawMessage,
      cause: error,
    });
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const code = classifyGcpProviderError(rawMessage);
  throw new SecretProviderClientError({
    code,
    provider: "gcp_secret_manager",
    operation,
    message: gcpProviderSafeMessage(code),
    rawMessage,
    cause: error,
  });
}

function credentialUnavailableError(operation: string, cause: unknown): SecretProviderClientError {
  const detail =
    cause instanceof SecretProviderClientError
      ? (cause.rawMessage ?? cause.message)
      : cause instanceof Error
        ? cause.message
        : String(cause);
  return new SecretProviderClientError({
    code: "access_denied",
    provider: "gcp_secret_manager",
    operation,
    message: GCP_CREDENTIAL_ACQUISITION_MESSAGE,
    rawMessage: `Google application default credentials are unavailable: ${detail}`,
    cause,
  });
}

/**
 * The vault's project is a tenancy boundary, not a default. Credentials here are the
 * deployment's application default credentials, shared by every company on the
 * deployment, so a reference that names someone else's project would be answered with
 * that project's plaintext wherever the deployment identity happens to have access.
 *
 * The comparison is exact, against the spelling the vault config uses. It is not a
 * project-identity lookup, because the Secret Manager API names a project two ways —
 * the id in vault config, the number in listing responses — and the two cannot be
 * reconciled without asking Google which number a given id has. That answer was
 * rejected on two grounds: resolving it lazily would make a security boundary depend on
 * whether a listing happened earlier in the process's life, and resolving it on the read
 * path would require secretmanager.secrets.list, which healthCheck deliberately does not
 * require of a least-privilege deployment. Instead listing rewrites every reference it
 * emits into the vault's own spelling (see listRemoteSecrets), so imported references
 * match by construction. The cost is stated plainly for the operator: a reference typed
 * by hand must use the same project spelling the vault config does.
 */
function assertRefWithinVault(ref: GcpSecretRef, config: GcpSecretManagerConfig): void {
  if (ref.projectId === config.projectId && ref.location === config.location) return;
  // The rejected reference is caller input and is deliberately not echoed back.
  throw unprocessable(
    "GCP Secret Manager external references must name this provider vault's own project and location",
  );
}

function parseSecretRef(
  externalRef: string | null | undefined,
  config: GcpSecretManagerConfig,
): GcpSecretRef {
  const trimmed = externalRef?.trim() ?? "";
  if (!trimmed) {
    throw unprocessable("GCP Secret Manager provider requires an external secret reference");
  }
  const full = FULL_SECRET_REF_RE.exec(trimmed);
  if (full) {
    const ref: GcpSecretRef = {
      projectId: full[1] as string,
      location: (full[2] as string | undefined) ?? null,
      secretId: full[3] as string,
    };
    assertRefWithinVault(ref, config);
    return ref;
  }
  if (BARE_SECRET_ID_RE.test(trimmed)) {
    return { projectId: config.projectId, location: config.location, secretId: trimmed };
  }
  // The rejected reference is caller input and is deliberately not echoed back.
  throw unprocessable(
    "GCP Secret Manager external references must be " +
      "projects/<project>[/locations/<location>]/secrets/<secret> or a bare secret id",
  );
}

function normalizeVersionRef(providerVersionRef: string | null | undefined): string {
  const trimmed = providerVersionRef?.trim();
  if (!trimmed) return DEFAULT_VERSION_ALIAS;
  if (!VERSION_REF_RE.test(trimmed)) {
    throw unprocessable(
      `GCP Secret Manager version references must be "${DEFAULT_VERSION_ALIAS}" or a positive version number`,
    );
  }
  return trimmed;
}

function createExternalReferenceMaterial(
  externalRef: string,
  providerVersionRef: string | null,
): PreparedSecretVersion {
  const normalizedExternalRef = externalRef.trim();
  const normalizedProviderVersionRef = providerVersionRef?.trim() || null;
  const fingerprint = sha256Hex(
    `${GCP_SECRET_MANAGER_SCHEME}:${normalizedExternalRef}:${normalizedProviderVersionRef ?? ""}`,
  );
  return {
    material: {
      scheme: GCP_SECRET_MANAGER_SCHEME,
      externalRef: normalizedExternalRef,
      providerVersionRef: normalizedProviderVersionRef,
      source: "external_reference",
    } satisfies GcpSecretManagerMaterial,
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: normalizedExternalRef,
    providerVersionRef: normalizedProviderVersionRef,
  };
}

function asGcpSecretManagerMaterial(value: StoredSecretVersionMaterial): GcpSecretManagerMaterial {
  if (value && typeof value === "object" && typeof value.externalRef === "string") {
    const providerVersionRef =
      typeof value.providerVersionRef === "string" ? value.providerVersionRef : null;
    if (value.scheme === GCP_SECRET_MANAGER_SCHEME) {
      return {
        scheme: GCP_SECRET_MANAGER_SCHEME,
        externalRef: value.externalRef,
        providerVersionRef,
        source: "external_reference",
      };
    }
    if (
      value.scheme === LEGACY_EXTERNAL_REFERENCE_SCHEME &&
      value.provider === "gcp_secret_manager"
    ) {
      return {
        scheme: GCP_SECRET_MANAGER_SCHEME,
        externalRef: value.externalRef,
        providerVersionRef,
        source: "external_reference",
      };
    }
  }
  throw unprocessable("Invalid GCP Secret Manager material");
}

function throwGcpHttpError(input: {
  operation: string;
  status: number;
  statusText: string;
  body: string;
}): never {
  // The API answers with { error: { status, message } }; the OAuth endpoint answers
  // with { error, error_description }. Both shapes end up in rawMessage only.
  let statusName = input.statusText;
  let message = input.body;
  try {
    const parsed = JSON.parse(input.body) as Record<string, unknown>;
    const apiError = typeof parsed.error === "object" && parsed.error !== null
      ? (parsed.error as Record<string, unknown>)
      : null;
    statusName =
      asOptionalNonEmptyString(apiError?.status) ??
      asOptionalNonEmptyString(parsed.error) ??
      input.statusText;
    message =
      asOptionalNonEmptyString(apiError?.message) ??
      asOptionalNonEmptyString(parsed.error_description) ??
      input.body;
  } catch {
    // A non-JSON body (an HTML proxy error, say) is reported as it arrived.
  }
  const code = classifyGcpProviderError(`${statusName} ${input.status}`);
  throw new SecretProviderClientError({
    code,
    provider: "gcp_secret_manager",
    operation: input.operation,
    message: gcpProviderSafeMessage(code),
    status: input.status,
    rawMessage: `HTTP ${input.status} ${statusName || "UNKNOWN"}: ${message}`,
  });
}

async function readJsonResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throwGcpHttpError({
      operation,
      status: response.status,
      statusText: response.statusText,
      body: text,
    });
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  projectId: string | null;
}

async function loadServiceAccountKey(keyPath: string): Promise<ServiceAccountKey> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(keyPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS could not be read as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Authorized-user and external-account files also live at this path but cannot be
  // signed locally, so they are rejected by name rather than failing at the exchange.
  if (parsed.type !== "service_account") {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS must point at a service-account key file (found type "${String(
        parsed.type ?? "unknown",
      )}")`,
    );
  }
  const clientEmail = asOptionalNonEmptyString(parsed.client_email);
  const privateKey = asOptionalNonEmptyString(parsed.private_key);
  if (!clientEmail || !privateKey) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is missing client_email or private_key");
  }
  return {
    clientEmail,
    privateKey,
    tokenUri: asOptionalNonEmptyString(parsed.token_uri) ?? DEFAULT_OAUTH_TOKEN_ENDPOINT,
    projectId: asOptionalNonEmptyString(parsed.project_id),
  };
}

function signServiceAccountAssertion(key: ServiceAccountKey): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signingInput = [
    base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64Url(
      JSON.stringify({
        iss: key.clientEmail,
        scope: CLOUD_PLATFORM_SCOPE,
        aud: key.tokenUri,
        iat: issuedAt,
        exp: issuedAt + SERVICE_ACCOUNT_ASSERTION_TTL_SECONDS,
      }),
    ),
  ].join(".");
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function readTokenResponse(payload: Record<string, unknown>, operation: string): GcpAccessToken {
  const accessToken = asOptionalNonEmptyString(payload.access_token);
  if (!accessToken) {
    throw credentialUnavailableError(
      operation,
      new Error("the token endpoint returned no access_token"),
    );
  }
  const expiresInSeconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return { accessToken, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
}

/**
 * Application default credentials, in the order a Google client library resolves them:
 * an explicitly configured token, a service-account key file, then the metadata server.
 */
class ApplicationDefaultCredentials implements GcpTokenSource {
  private metadataUnavailableUntil = 0;
  private lastSource = "unresolved";

  hasDetectedCredentials(): boolean {
    if (resolveStaticAccessToken()) return true;
    const keyPath = resolveServiceAccountKeyPath();
    if (keyPath && existsSync(keyPath)) return true;
    // The most common production shape has neither: credentials come from the metadata
    // server. Cloud Run, Cloud Run functions and App Engine say so in the environment,
    // so those are reported configured without a probe. GKE workload identity and bare
    // Compute Engine advertise nothing, so they report configured only once a token has
    // actually been acquired — CachedTokenSource answers true from its live token.
    return hasHostedGcpRuntimeMarker();
  }

  describe(): string {
    return this.lastSource;
  }

  async fetchAccessToken(): Promise<GcpAccessToken> {
    const staticToken = resolveStaticAccessToken();
    if (staticToken) {
      this.lastSource = "configured access token";
      return { accessToken: staticToken, expiresAtMs: Date.now() + STATIC_TOKEN_REFRESH_MS };
    }

    const keyPath = resolveServiceAccountKeyPath();
    if (keyPath) {
      // A rejected assertion is a credential problem, not a malformed Secret Manager
      // request, so the whole exchange reports as one credential failure.
      const token = await this.exchangeServiceAccountAssertion(keyPath).catch((error: unknown) => {
        throw credentialUnavailableError("fetchAccessToken", error);
      });
      this.lastSource = "service-account key file";
      return token;
    }

    const body = await this.callMetadataServer(METADATA_TOKEN_PATH, "fetchAccessToken");
    const token = readTokenResponse(JSON.parse(body) as Record<string, unknown>, "fetchAccessToken");
    this.lastSource = "Compute Engine metadata server";
    return token;
  }

  /**
   * Only the key file carries a project id. The metadata server exposes one too, but
   * every deployment health-checks every provider, and an unconfigured GCP provider
   * must answer without paying a metadata probe — so the project stays explicit config.
   */
  async resolveProjectId(): Promise<string | null> {
    const keyPath = resolveServiceAccountKeyPath();
    if (!keyPath) return null;
    return (await loadServiceAccountKey(keyPath)).projectId;
  }

  private async exchangeServiceAccountAssertion(keyPath: string): Promise<GcpAccessToken> {
    const key = await loadServiceAccountKey(keyPath);
    const response = await fetch(key.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountAssertion(key),
      }).toString(),
      signal: AbortSignal.timeout(GCP_REQUEST_TIMEOUT_MS),
    });
    return readTokenResponse(await readJsonResponse(response, "fetchAccessToken"), "fetchAccessToken");
  }

  private async callMetadataServer(path: string, operation: string): Promise<string> {
    if (Date.now() < this.metadataUnavailableUntil) {
      throw credentialUnavailableError(
        operation,
        new Error("the metadata server did not respond to a recent probe"),
      );
    }
    let response: Response;
    try {
      response = await fetch(`${resolveMetadataOrigin()}${path}`, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(METADATA_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      this.metadataUnavailableUntil = Date.now() + METADATA_UNAVAILABLE_BACKOFF_MS;
      throw credentialUnavailableError(operation, error);
    }
    const text = await response.text();
    if (!response.ok) {
      throw credentialUnavailableError(operation, new Error(`HTTP ${response.status}: ${text}`));
    }
    return text;
  }
}

/**
 * Wraps any token source with the caching and in-flight de-duplication the provider
 * needs, so a burst of resolves costs one token exchange rather than one each.
 */
class CachedTokenSource {
  private cached: GcpAccessToken | null = null;
  private pending: Promise<string> | null = null;

  constructor(private readonly delegate: GcpTokenSource) {}

  hasFreshToken(): boolean {
    return Boolean(this.cached && this.cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > Date.now());
  }

  hasDetectedCredentials(): boolean {
    if (this.hasFreshToken()) return true;
    return this.delegate.hasDetectedCredentials?.() ?? true;
  }

  describe(): string {
    return this.delegate.describe?.() ?? "configured token source";
  }

  resolveProjectId(): Promise<string | null> {
    return this.delegate.resolveProjectId?.() ?? Promise.resolve(null);
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return this.cached.accessToken;
    }
    if (this.pending) return this.pending;
    this.pending = this.delegate
      .fetchAccessToken()
      .then((token) => {
        this.cached = token;
        return token.accessToken;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

// A regional resource carries a locations/ segment; a global one does not. The endpoint
// and the path have to agree, which is why both derive from the same config.location.
function resourceParentPath(input: { projectId: string; location: string | null }): string {
  const project = `/v1/projects/${encodeURIComponent(input.projectId)}`;
  return input.location ? `${project}/locations/${encodeURIComponent(input.location)}` : project;
}

class GcpSecretManagerRestGateway implements GcpSecretManagerGateway {
  constructor(
    private readonly config: GcpSecretManagerConfig,
    private readonly tokens: CachedTokenSource,
  ) {}

  async accessSecretVersion(input: {
    projectId: string;
    location: string | null;
    secretId: string;
    version: string;
  }) {
    const path =
      `${resourceParentPath(input)}/secrets/${encodeURIComponent(input.secretId)}` +
      `/versions/${encodeURIComponent(input.version)}:access`;
    return (await this.call("accessSecretVersion", path)) as { payload?: { data?: string } };
  }

  async listSecrets(input: {
    projectId: string;
    location: string | null;
    pageSize?: number;
    pageToken?: string;
  }) {
    const query = new URLSearchParams();
    if (input.pageSize) query.set("pageSize", String(input.pageSize));
    if (input.pageToken) query.set("pageToken", input.pageToken);
    const suffix = query.toString();
    const path = `${resourceParentPath(input)}/secrets${suffix ? `?${suffix}` : ""}`;
    return (await this.call("listSecrets", path)) as {
      secrets?: GcpSecretEntry[];
      nextPageToken?: string;
    };
  }

  private async call(operation: string, path: string): Promise<Record<string, unknown>> {
    const accessToken = await this.tokens.getAccessToken();
    const response = await fetch(`${this.config.endpoint}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(GCP_REQUEST_TIMEOUT_MS),
    });
    return readJsonResponse(response, operation);
  }
}

// Parses a resource name Google returned. Unlike parseSecretRef this applies no tenancy
// check: the caller asked Google for one project's secrets, so the answer is that
// project by construction, spelled with whichever project form the API chose.
function secretIdFromResourceName(name: string | undefined): GcpSecretRef | null {
  const match = FULL_SECRET_REF_RE.exec(name?.trim() ?? "");
  if (!match) return null;
  return {
    projectId: match[1] as string,
    location: (match[2] as string | undefined) ?? null,
    secretId: match[3] as string,
  };
}

function createRemoteSecretMetadata(entry: GcpSecretEntry): Record<string, unknown> {
  return {
    createTime: asOptionalNonEmptyString(entry.createTime),
    hasExpiry: Boolean(entry.expireTime),
    labelCount: entry.labels ? Object.keys(entry.labels).length : 0,
  };
}

function commonValue(values: Array<string | null | undefined>): string | null {
  const nonEmpty = values.filter((value): value is string => Boolean(value?.trim()));
  if (nonEmpty.length === 0) return null;
  const first = nonEmpty[0];
  return nonEmpty.every((value) => value === first) ? (first as string) : null;
}

function labelValue(labels: Record<string, string> | undefined, keys: string[]): string | null {
  for (const key of keys) {
    const value = asOptionalNonEmptyString(labels?.[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Secret ids are flat in Secret Manager, so the only naming signal available is the
 * leading dash-delimited segment that deployments conventionally use as a prefix.
 */
function inferSecretNamePrefix(secretId: string): string | null {
  const segments = secretId.split("-").filter(Boolean);
  return segments.length >= 2 ? (segments[0] as string) : null;
}

function discoverGcpProviderConfigCandidates(input: {
  config: GcpSecretManagerConfig;
  draftConfig: Record<string, unknown>;
  entries: GcpSecretEntry[];
  nextToken: string | null;
}): SecretProviderConfigDiscoveryPreviewResult {
  type DiscoverySample = {
    secretId: string;
    prefix: string | null;
    namespace: string | null;
    environmentTag: string | null;
    ownerTag: string | null;
    labelKeys: string[];
  };

  const draftProjectId = asOptionalNonEmptyString(input.draftConfig.projectId);
  const draftLocation = asOptionalNonEmptyString(input.draftConfig.location);
  const draftNamespace = asOptionalNonEmptyString(input.draftConfig.namespace);
  const draftPrefix = asOptionalNonEmptyString(input.draftConfig.secretNamePrefix);
  const samples: DiscoverySample[] = [];

  for (const entry of input.entries) {
    const parsed = secretIdFromResourceName(entry.name);
    if (!parsed) continue;
    samples.push({
      secretId: parsed.secretId,
      prefix: inferSecretNamePrefix(parsed.secretId),
      namespace: labelValue(entry.labels, ["namespace", "deployment", "stack"]),
      environmentTag: labelValue(entry.labels, ["environment", "env", "stage"]),
      ownerTag: labelValue(entry.labels, ["owner", "team", "service", "application"]),
      labelKeys: Object.keys(entry.labels ?? {}).sort(),
    });
  }

  const groups = new Map<string, DiscoverySample[]>();
  for (const sample of samples) {
    const key = draftPrefix ?? sample.prefix ?? "";
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  const candidates = [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT)
    .map((group) => {
      const prefix = draftPrefix ?? commonValue(group.map((sample) => sample.prefix));
      const namespace = draftNamespace ?? commonValue(group.map((sample) => sample.namespace));
      const environmentTag = commonValue(group.map((sample) => sample.environmentTag));
      const ownerTag = commonValue(group.map((sample) => sample.ownerTag));
      const candidateWarnings: string[] = [];

      if (!prefix) {
        candidateWarnings.push("No stable secret name prefix was found in the sampled GCP secret names.");
      }
      if (!namespace) {
        candidateWarnings.push("No namespace label was found on the sampled GCP secrets.");
      }
      if (!environmentTag) {
        candidateWarnings.push("No common environment label was found on the sampled GCP secrets.");
      }

      return {
        provider: "gcp_secret_manager" as const,
        displayName: `GCP ${environmentTag ?? namespace ?? prefix ?? ownerTag ?? "discovered"}`,
        config: {
          projectId: draftProjectId ?? input.config.projectId,
          location: draftLocation ?? input.config.location,
          namespace,
          secretNamePrefix: prefix,
        },
        sampleCount: group.length,
        samples: group.slice(0, PROVIDER_CONFIG_DISCOVERY_SAMPLE_LIMIT).map((sample) => ({
          name: sample.secretId,
          // Secret Manager encrypts with a Google-managed key unless a CMEK is set on
          // the replication policy, which listing metadata does not expose.
          hasKmsKey: false,
          tagKeys: sample.labelKeys,
        })),
        signals: {
          namespace,
          secretNamePrefix: prefix,
          environmentTag,
          ownerTag,
          kmsKeyId: null,
          hasKmsKey: false,
          sampleCount: group.length,
          // Paperclip owns no values in this provider, so no sample can be its own.
          paperclipManagedSampleCount: 0,
          skippedForeignPaperclipSampleCount: 0,
        },
        warnings: candidateWarnings,
      };
    });

  const warnings: string[] = [];
  if (samples.length === 0) {
    warnings.push("GCP Secret Manager returned no metadata samples for this draft provider vault config.");
  }
  if (groups.size > PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT) {
    warnings.push("Additional GCP secret name groups were omitted from this preview; refine the query to inspect them.");
  }

  return {
    provider: "gcp_secret_manager",
    nextToken: input.nextToken,
    sampledSecretCount: samples.length,
    skippedForeignPaperclipSampleCount: 0,
    candidates,
    warnings,
  };
}

function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): GcpSecretManagerConfig {
  if (input.provider !== "gcp_secret_manager") {
    throw unprocessable("GCP Secret Manager provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("GCP Secret Manager provider vault is disabled");
  }
  // A vault an operator deliberately parked, not a provider without a runtime module.
  // The status is theirs to set and theirs to clear, and the AWS provider honours it the
  // same way; the provider-level coming-soon gates are gone.
  if (input.status === "coming_soon") {
    throw unprocessable("GCP Secret Manager provider vault runtime is locked while coming soon");
  }
  // Deliberately no deployment-env fallback: a company vault inheriting the
  // deployment's project would silently read another tenant's secrets.
  const projectId = asOptionalNonEmptyString(input.config.projectId);
  if (!projectId) {
    throw unprocessable("GCP Secret Manager provider vault requires non-secret config: projectId");
  }
  if (!isProjectRef(projectId)) {
    throw unprocessable("GCP Secret Manager provider vault projectId is malformed");
  }
  const location = asOptionalNonEmptyString(input.config.location);
  if (location && !GCP_LOCATION_RE.test(location)) {
    throw unprocessable("GCP Secret Manager provider vault location is malformed");
  }
  const normalizedLocation = normalizeLocation(location);
  return {
    projectId,
    location: normalizedLocation,
    endpoint: resolveEndpoint(normalizedLocation),
  };
}

export function createGcpSecretManagerProvider(options?: {
  config?: GcpSecretManagerConfig;
  gateway?: GcpSecretManagerGateway;
  tokenSource?: GcpTokenSource;
}): SecretProviderModule {
  const tokens = new CachedTokenSource(options?.tokenSource ?? new ApplicationDefaultCredentials());
  // A project id read out of the credentials is remembered so `descriptor()` — which is
  // synchronous and must not touch the network — can report readiness after the first call.
  let credentialProjectId: string | null = null;

  function resolveConfiguredProjectId(): string | null {
    return options?.config?.projectId ?? resolveEnvProjectId() ?? credentialProjectId;
  }

  async function resolveConfig(
    providerConfig?: SecretProviderVaultRuntimeConfig | null,
  ): Promise<GcpSecretManagerConfig> {
    if (providerConfig) return readProviderVaultConfig(providerConfig);
    if (options?.config) return options.config;
    let projectId = resolveConfiguredProjectId();
    if (!projectId) {
      // A broken key file is reported by the credential probe in healthCheck; here it
      // only means the project id has to come from configuration instead.
      credentialProjectId = await tokens.resolveProjectId().catch(() => null);
      projectId = credentialProjectId;
    }
    if (!projectId) {
      throw unprocessable(
        "GCP Secret Manager provider requires PAPERCLIP_SECRETS_GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT",
      );
    }
    if (!isProjectRef(projectId)) {
      throw unprocessable("GCP Secret Manager project id is malformed");
    }
    // The deployment-level config is global: a region is a per-vault choice, so there is
    // no deployment env var that could put the default provider on a regional endpoint.
    return { projectId, location: null, endpoint: resolveEndpoint(null) };
  }

  function resolveGateway(config: GcpSecretManagerConfig): GcpSecretManagerGateway {
    return options?.gateway ?? new GcpSecretManagerRestGateway(config, tokens);
  }

  /**
   * Discovery lists a project using the deployment's own credentials, from a draft vault
   * config the caller supplied and nobody has saved, reviewed or authorized. Unconstrained
   * that is a project enumerator: anyone who can open the new-vault dialog could read back
   * the secret names and labels of any project this deployment's identity can see.
   *
   * So discovery is confined to the one project the deployment itself declares. It is a
   * convenience — it prefills a vault form — and nothing else depends on it: a vault in
   * another project is configured by typing its project id, and then link and resolve work
   * with no listing permission at all.
   */
  async function assertDiscoverableProject(config: GcpSecretManagerConfig): Promise<void> {
    let deploymentConfig: GcpSecretManagerConfig;
    try {
      deploymentConfig = await resolveConfig();
    } catch {
      // Reported as the discovery rule rather than as the generic missing-project error,
      // so an operator is told why the deployment has to declare a project for this call.
      throw unprocessable(
        "GCP Secret Manager provider vault discovery requires the deployment to declare its own project id",
      );
    }
    if (deploymentConfig.projectId !== config.projectId) {
      throw unprocessable(
        "GCP Secret Manager provider vault discovery is limited to the project this deployment is configured for",
      );
    }
  }

  async function validateConfig(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    if (resolveStaticAccessToken()) {
      warnings.push(
        "A static GCP access token is visible to this process; prefer workload identity or the Compute Engine metadata server for hosted deployments.",
      );
    }
    try {
      await resolveConfig(input?.providerConfig);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return { ok: false, warnings };
    }
    return { ok: true, warnings };
  }

  async function healthCheck(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderHealthCheck> {
    const validation = await validateConfig(input);
    let config: GcpSecretManagerConfig | null = null;
    let unreadyReason: string | null = null;
    try {
      config = await resolveConfig(input?.providerConfig);
    } catch (error) {
      unreadyReason = error instanceof Error ? error.message : String(error);
    }
    // Every deployment health-checks every provider, so an unconfigured GCP provider
    // must answer without touching the credential chain at all.
    if (!config) {
      return {
        provider: "gcp_secret_manager",
        status: "warn",
        message: `GCP Secret Manager provider is not ready: ${unreadyReason ?? "configuration is incomplete"}`,
        warnings: [
          ...validation.warnings,
          GCP_RUNTIME_CREDENTIAL_WARNING,
          GCP_CREDENTIAL_CUSTODY_WARNING,
          "External reference resolution will fail until GCP provider configuration is complete.",
        ],
        details: {
          requiredProviderConfig: input?.providerConfig
            ? ["projectId"]
            : ["PAPERCLIP_SECRETS_GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT"],
          optionalProviderConfig: input?.providerConfig
            ? ["location"]
            : [
                "GOOGLE_APPLICATION_CREDENTIALS",
                "PAPERCLIP_SECRETS_GCP_ENDPOINT",
                "PAPERCLIP_SECRETS_GCP_ACCESS_TOKEN",
              ],
          credentialSource: "Google application default credentials",
        },
      };
    }

    try {
      // A credential probe only: resolution needs secretmanager.versions.access, and a
      // least-privilege deployment that cannot list secrets is still perfectly healthy.
      await tokens.getAccessToken();
    } catch (error) {
      return {
        provider: "gcp_secret_manager",
        status: "error",
        message: "GCP Secret Manager provider could not acquire Google application default credentials.",
        warnings: [...validation.warnings, GCP_RUNTIME_CREDENTIAL_WARNING, GCP_CREDENTIAL_CUSTODY_WARNING],
        details: {
          projectId: config.projectId,
          credentialSource: tokens.describe(),
          reason:
            error instanceof SecretProviderClientError
              ? error.code
              : error instanceof Error
                ? error.name
                : "unknown",
        },
      };
    }

    return {
      provider: "gcp_secret_manager",
      status: validation.warnings.length > 0 ? "warn" : "ok",
      message:
        "GCP Secret Manager provider config is present and Google application default credentials resolved.",
      warnings: validation.warnings,
      details: {
        projectId: config.projectId,
        location: config.location ?? GLOBAL_LOCATION,
        endpoint: config.endpoint,
        credentialSource: tokens.describe(),
      },
      backupGuidance: [
        "Back up Paperclip metadata separately from Google-managed secrets.",
        "Restoring access requires the Paperclip database plus the same GCP project and IAM bindings.",
      ],
    };
  }

  return {
    id: "gcp_secret_manager",
    descriptor() {
      return {
        id: "gcp_secret_manager",
        label: "GCP Secret Manager",
        requiresExternalRef: true,
        supportsManagedValues: false,
        supportsExternalReferences: true,
        supportsExternalValueWrites: false,
        // Synchronous, so this reports the credentials that can be detected without a
        // request. On an instance whose only credential is the metadata server this
        // stays false until a token has actually been acquired.
        configured: Boolean(resolveConfiguredProjectId()) && tokens.hasDetectedCredentials(),
      };
    },
    validateConfig,
    async createSecret() {
      throw unprocessable(
        "GCP Secret Manager secrets are referenced, not managed by Paperclip; create the secret in GCP and link it",
      );
    },
    async createVersion() {
      throw unprocessable(
        "GCP Secret Manager secret versions are managed in GCP; add the version in GCP and resolve it by reference",
      );
    },
    async linkExternalSecret(input) {
      // Always resolved, including for a full resource reference: the vault's project is
      // what a reference has to be checked against, so there is no reference shape that
      // can be linked without knowing it.
      const config = await resolveConfig(input.providerConfig);
      // Checked at link time as well as at resolve time so a reference that is malformed
      // or outside the vault is refused at the boundary instead of being persisted and
      // failing — or worse, resolving — later.
      parseSecretRef(input.externalRef, config);
      const providerVersionRef = input.providerVersionRef?.trim()
        ? normalizeVersionRef(input.providerVersionRef)
        : null;
      // Stored as the operator wrote it. A full reference that got this far is already
      // the vault's own canonical spelling, and a bare id expands against the vault it
      // resolves under, so there is nothing left to normalise.
      return createExternalReferenceMaterial(input.externalRef, providerVersionRef);
    },
    async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
      const config = await resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const query = input.query?.trim().toLowerCase();
      const pageSize =
        input.pageSize && Number.isFinite(input.pageSize)
          ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
          : 50;

      try {
        if (!gateway.listSecrets) {
          throw new Error("listSecrets gateway operation is unavailable");
        }
        const listed = await gateway.listSecrets({
          projectId: config.projectId,
          location: config.location,
          pageSize,
          pageToken: input.nextToken?.trim() || undefined,
        });
        const secrets = (listed.secrets ?? [])
          .map((entry) => ({ entry, ref: secretIdFromResourceName(entry.name) }))
          .filter(
            (candidate): candidate is { entry: GcpSecretEntry; ref: GcpSecretRef } =>
              candidate.ref !== null &&
              // Filtered here rather than through the API's filter parameter: the operator
              // query is free text and Secret Manager's filter grammar would reject or,
              // worse, reinterpret it.
              (!query || candidate.ref.secretId.toLowerCase().includes(query)),
          )
          .map(({ entry, ref }) => ({
            // Rewritten into the vault's own spelling rather than echoed back. Listing
            // answers with the project NUMBER while vault config holds the project ID,
            // and the two are the same project here by construction — we asked Google for
            // this vault's project. Emitting the vault's spelling is what lets an
            // imported reference pass the tenancy check in assertRefWithinVault.
            externalRef: canonicalSecretRef(config, ref.secretId),
            name: ref.secretId,
            providerVersionRef: null,
            metadata: createRemoteSecretMetadata(entry),
          }));
        return { nextToken: listed.nextPageToken ?? null, secrets };
      } catch (error) {
        normalizeGcpError("listSecrets", error);
      }
    },
    async discoverProviderConfigs(input): Promise<SecretProviderConfigDiscoveryPreviewResult> {
      const config = await resolveConfig(input.providerConfig);
      await assertDiscoverableProject(config);
      const gateway = resolveGateway(config);
      const pageSize =
        input.pageSize && Number.isFinite(input.pageSize)
          ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
          : 100;

      try {
        if (!gateway.listSecrets) {
          throw new Error("listSecrets gateway operation is unavailable");
        }
        const listed = await gateway.listSecrets({
          projectId: config.projectId,
          location: config.location,
          pageSize,
          pageToken: input.nextToken?.trim() || undefined,
        });
        return discoverGcpProviderConfigCandidates({
          config,
          draftConfig: input.providerConfig.config,
          entries: listed.secrets ?? [],
          nextToken: listed.nextPageToken ?? null,
        });
      } catch (error) {
        normalizeGcpError("discoverProviderConfigs", error);
      }
    },
    async resolveVersion(input) {
      const config = await resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const material = asGcpSecretManagerMaterial(input.material);
      // The stored reference is the fallback; the secret row's own reference wins so an
      // operator can repoint a link without rewriting version material. Either way the
      // reference is re-checked against the vault: a row written before this boundary
      // existed, or repointed since, does not get to bypass it.
      const ref = parseSecretRef(input.externalRef ?? material.externalRef, config);
      const version = normalizeVersionRef(input.providerVersionRef ?? material.providerVersionRef);

      try {
        const resolved = await gateway.accessSecretVersion({
          projectId: ref.projectId,
          location: ref.location,
          secretId: ref.secretId,
          version,
        });
        const payload = resolved.payload;
        if (!payload) {
          throw new Error("The secret version payload was missing");
        }
        // proto3 JSON omits default values, so an empty secret comes back with no `data`
        // field at all rather than an empty string. An empty secret is a legitimate value.
        const data = payload.data ?? "";
        if (typeof data !== "string") {
          throw new Error("The secret version payload was malformed");
        }
        return Buffer.from(data, "base64").toString("utf8");
      } catch (error) {
        normalizeGcpError("resolveVersion", error);
      }
    },
    async deleteOrArchive() {
      // External references are links, not ownership: Paperclip destroying a secret it
      // did not create would take down every other consumer of that secret.
    },
    healthCheck,
  };
}

export const gcpSecretManagerProvider = createGcpSecretManagerProvider();
