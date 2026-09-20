import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGcpSecretManagerProvider,
  type GcpSecretManagerGateway,
  type GcpTokenSource,
} from "../secrets/gcp-secret-manager-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

const GCP_ENV_KEYS = [
  "PAPERCLIP_SECRETS_GCP_PROJECT_ID",
  "PAPERCLIP_SECRETS_GCP_ENDPOINT",
  "PAPERCLIP_SECRETS_GCP_ACCESS_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

const TEST_CONFIG = {
  projectId: "my-project",
  endpoint: "https://secretmanager.googleapis.com",
};

function staticTokenSource(accessToken = "test-access-token"): GcpTokenSource {
  return {
    async fetchAccessToken() {
      return { accessToken, expiresAtMs: Date.now() + 3_600_000 };
    },
  };
}

function base64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function unusedGateway(): GcpSecretManagerGateway {
  return {
    async accessSecretVersion() {
      throw new Error("accessSecretVersion must not be called");
    },
    async listSecrets() {
      throw new Error("listSecrets must not be called");
    },
  };
}

describe("gcpSecretManagerProvider", () => {
  // The suite must behave the same on a developer machine that already has Google
  // credentials in its environment as it does on a build agent that has none.
  const previousEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of GCP_ENV_KEYS) {
      previousEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const key of GCP_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("resolves a secret value by base64-decoding the access payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion(input) {
          calls.push(input);
          return { payload: { data: base64("resolved-secret-value") } };
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "gcp_secret_manager_v1",
        externalRef: "projects/my-project/secrets/db-password",
        providerVersionRef: null,
        source: "external_reference",
      },
      externalRef: "projects/my-project/secrets/db-password",
    });

    expect(resolved).toBe("resolved-secret-value");
    expect(calls).toEqual([
      { projectId: "my-project", secretId: "db-password", version: "latest" },
    ]);
  });

  it("selects the pinned provider version and falls back to latest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion(input) {
          calls.push(input);
          return { payload: { data: base64("value") } };
        },
      },
    });
    const material = {
      scheme: "gcp_secret_manager_v1",
      externalRef: "projects/my-project/secrets/db-password",
      providerVersionRef: null,
      source: "external_reference",
    };

    await provider.resolveVersion({
      material,
      externalRef: "projects/my-project/secrets/db-password",
      providerVersionRef: "7",
    });
    await provider.resolveVersion({
      material,
      externalRef: "projects/my-project/secrets/db-password",
      providerVersionRef: null,
    });

    expect(calls.map((call) => call.version)).toEqual(["7", "latest"]);
  });

  it("expands a bare secret id against the configured project", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion(input) {
          calls.push(input);
          return { payload: { data: base64("value") } };
        },
      },
    });

    const linked = await provider.linkExternalSecret({ externalRef: "db-password" });
    await provider.resolveVersion({ material: linked.material, externalRef: linked.externalRef });

    expect(linked.externalRef).toBe("db-password");
    expect(calls).toEqual([
      { projectId: "my-project", secretId: "db-password", version: "latest" },
    ]);
  });

  it("rejects external references that are not a secret resource name or a bare secret id", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: unusedGateway(),
    });

    const rejected = [
      "../../../projects/other-project/secrets/db-password",
      "projects/my-project/secrets/../../other-project/secrets/db-password",
      "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/db-password",
      "projects/my-project/secrets/db-password/versions/1",
      "organizations/123/secrets/db-password",
      "projects/my-project/secrets/db password",
      "db-password?alt=media",
    ];

    for (const externalRef of rejected) {
      await expect(provider.linkExternalSecret({ externalRef })).rejects.toThrow(
        /must be projects\/<project>\/secrets\/<secret> or a bare secret id/i,
      );
      await expect(
        provider.resolveVersion({
          material: {
            scheme: "gcp_secret_manager_v1",
            externalRef,
            providerVersionRef: null,
            source: "external_reference",
          },
          externalRef,
        }),
      ).rejects.toThrow(/must be projects\/<project>\/secrets\/<secret> or a bare secret id/i);
    }

    // A well-formed reference into another project is legitimate cross-project access.
    await expect(
      provider.linkExternalSecret({ externalRef: "projects/other-project/secrets/db-password" }),
    ).resolves.toMatchObject({ externalRef: "projects/other-project/secrets/db-password" });
  });

  it("stores linked external references as metadata only", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: unusedGateway(),
    });

    const prepared = await provider.linkExternalSecret({
      externalRef: "projects/my-project/secrets/db-password",
      providerVersionRef: "12",
    });

    expect(prepared.material).toEqual({
      scheme: "gcp_secret_manager_v1",
      externalRef: "projects/my-project/secrets/db-password",
      providerVersionRef: "12",
      source: "external_reference",
    });
    expect(prepared.externalRef).toBe("projects/my-project/secrets/db-password");
    expect(prepared.providerVersionRef).toBe("12");
    expect(prepared.valueSha256).toBeTruthy();
    expect(prepared.fingerprintSha256).toBe(prepared.valueSha256);
  });

  it("still resolves external references linked under the pre-provider material scheme", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion(input) {
          calls.push(input);
          return { payload: { data: base64("legacy-value") } };
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "external_reference_v1",
        provider: "gcp_secret_manager",
        externalRef: "projects/my-project/secrets/db-password",
        providerVersionRef: "3",
      },
      externalRef: null,
    });

    expect(resolved).toBe("legacy-value");
    expect(calls).toEqual([{ projectId: "my-project", secretId: "db-password", version: "3" }]);
  });

  it("refuses to manage secret values", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: unusedGateway(),
    });

    await expect(provider.createSecret({ value: "super-secret-value" })).rejects.toThrow(
      /referenced, not managed by Paperclip/i,
    );
    await expect(provider.createVersion({ value: "super-secret-value" })).rejects.toThrow(
      /managed in GCP/i,
    );
    expect(provider.updateExternalSecretValue).toBeUndefined();
    expect(provider.descriptor()).toMatchObject({
      requiresExternalRef: true,
      supportsManagedValues: false,
      supportsExternalReferences: true,
      supportsExternalValueWrites: false,
    });
  });

  it("never deletes a secret it does not own", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: unusedGateway(),
    });

    await expect(
      provider.deleteOrArchive({
        mode: "delete",
        externalRef: "projects/my-project/secrets/db-password",
        material: {
          scheme: "gcp_secret_manager_v1",
          externalRef: "projects/my-project/secrets/db-password",
          providerVersionRef: null,
          source: "external_reference",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("requests the documented access URL with a bearer token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response(JSON.stringify({ payload: { data: base64("resolved-secret-value") } }), {
          status: 200,
        }),
      );
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource("ya29.test-token"),
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "gcp_secret_manager_v1",
        externalRef: "projects/my-project/secrets/my-secret",
        providerVersionRef: null,
        source: "external_reference",
      },
      externalRef: "projects/my-project/secrets/my-secret",
    });

    expect(resolved).toBe("resolved-secret-value");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/my-secret/versions/latest:access",
    );
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ya29.test-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a denied access to access_denied without echoing the resource path", async () => {
    const rawBody = JSON.stringify({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message:
          "Permission 'secretmanager.versions.access' denied for resource 'projects/my-project/secrets/db-password/versions/latest' (or it may not exist). Caller: paperclip@my-project.iam.gserviceaccount.com",
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(rawBody, { status: 403, statusText: "Forbidden" }),
    );
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
    });

    let thrown: unknown;
    try {
      await provider.resolveVersion({
        material: {
          scheme: "gcp_secret_manager_v1",
          externalRef: "projects/my-project/secrets/db-password",
          providerVersionRef: null,
          source: "external_reference",
        },
        externalRef: "projects/my-project/secrets/db-password",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretProviderClientError);
    expect(thrown).toMatchObject({
      code: "access_denied",
      status: 403,
      operation: "resolveVersion",
      message: "GCP Secret Manager denied the request. Check the IAM bindings for this provider vault.",
    });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("projects/my-project");
    expect(message).not.toContain("iam.gserviceaccount.com");
    expect((thrown as SecretProviderClientError).rawMessage).toContain("PERMISSION_DENIED");
  });

  it("maps quota exhaustion to throttled and a transport failure to provider_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" },
        }),
        { status: 429, statusText: "Too Many Requests" },
      ),
    );
    const throttledProvider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
    });
    const material = {
      scheme: "gcp_secret_manager_v1",
      externalRef: "projects/my-project/secrets/db-password",
      providerVersionRef: null,
      source: "external_reference",
    };

    await expect(
      throttledProvider.resolveVersion({
        material,
        externalRef: "projects/my-project/secrets/db-password",
      }),
    ).rejects.toMatchObject({ code: "throttled", status: 429 });

    const offlineProvider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion() {
          throw new TypeError("fetch failed");
        },
      },
    });

    await expect(
      offlineProvider.resolveVersion({
        material,
        externalRef: "projects/my-project/secrets/db-password",
      }),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      message: "GCP Secret Manager is unavailable right now.",
    });
  });

  it("lists remote secrets as metadata and never accesses a payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion() {
          throw new Error("accessSecretVersion must not be used for remote import preview");
        },
        async listSecrets(input) {
          calls.push(input);
          return {
            nextPageToken: "page-2",
            secrets: [
              {
                name: "projects/123456789012/secrets/prod-db-password",
                createTime: "2026-05-06T00:00:00Z",
                labels: { environment: "production", owner: "platform" },
              },
              {
                name: "projects/123456789012/secrets/prod-openai-api-key",
                createTime: "2026-05-07T00:00:00Z",
                expireTime: "2027-01-01T00:00:00Z",
              },
              { name: "projects/123456789012/secrets/staging-openai-api-key" },
            ],
          };
        },
      },
    });

    const listed = await provider.listRemoteSecrets?.({
      query: "prod-",
      nextToken: "page-1",
      pageSize: 25,
    });

    expect(calls).toEqual([{ projectId: "my-project", pageSize: 25, pageToken: "page-1" }]);
    expect(listed).toEqual({
      nextToken: "page-2",
      secrets: [
        {
          externalRef: "projects/123456789012/secrets/prod-db-password",
          name: "prod-db-password",
          providerVersionRef: null,
          metadata: { createTime: "2026-05-06T00:00:00Z", hasExpiry: false, labelCount: 2 },
        },
        {
          externalRef: "projects/123456789012/secrets/prod-openai-api-key",
          name: "prod-openai-api-key",
          providerVersionRef: null,
          metadata: { createTime: "2026-05-07T00:00:00Z", hasExpiry: true, labelCount: 0 },
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("payload");
    expect(JSON.stringify(listed)).not.toContain("production");
  });

  it("previews provider vault prefill candidates from listing metadata", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: {
        async accessSecretVersion() {
          throw new Error("accessSecretVersion must not be used for provider vault discovery");
        },
        async listSecrets() {
          return {
            nextPageToken: "page-2",
            secrets: [
              {
                name: "projects/123456789012/secrets/prod-db-password",
                labels: { environment: "production", namespace: "core" },
              },
              {
                name: "projects/123456789012/secrets/prod-openai-api-key",
                labels: { environment: "production", namespace: "core" },
              },
            ],
          };
        },
      },
    });

    const preview = await provider.discoverProviderConfigs?.({
      companyId: "company-1",
      providerConfig: {
        id: "draft",
        provider: "gcp_secret_manager",
        status: "ready",
        config: { projectId: "my-project" },
      },
    });

    expect(preview).toMatchObject({
      provider: "gcp_secret_manager",
      nextToken: "page-2",
      sampledSecretCount: 2,
      skippedForeignPaperclipSampleCount: 0,
      candidates: [
        {
          displayName: "GCP production",
          config: {
            projectId: "my-project",
            location: null,
            namespace: "core",
            secretNamePrefix: "prod",
          },
          sampleCount: 2,
          signals: expect.objectContaining({
            secretNamePrefix: "prod",
            environmentTag: "production",
            hasKmsKey: false,
            paperclipManagedSampleCount: 0,
          }),
        },
      ],
    });
  });

  it("caches the access token across calls and refreshes it after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    let issued = 0;
    const tokenSource: GcpTokenSource = {
      async fetchAccessToken() {
        issued += 1;
        return { accessToken: `token-${issued}`, expiresAtMs: Date.now() + 3_600_000 };
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response(JSON.stringify({ payload: { data: base64("value") } }), { status: 200 }),
      );
    const provider = createGcpSecretManagerProvider({ config: TEST_CONFIG, tokenSource });
    const resolve = () =>
      provider.resolveVersion({
        material: {
          scheme: "gcp_secret_manager_v1",
          externalRef: "projects/my-project/secrets/db-password",
          providerVersionRef: null,
          source: "external_reference",
        },
        externalRef: "projects/my-project/secrets/db-password",
      });

    await resolve();
    await resolve();
    expect(issued).toBe(1);

    // Past the cached token's expiry, the next call must acquire a new one.
    vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
    await resolve();
    expect(issued).toBe(2);

    const authorizations = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).authorization,
    );
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });

  it("acquires the token once when concurrent resolves race", async () => {
    let issued = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tokenSource: GcpTokenSource = {
      async fetchAccessToken() {
        issued += 1;
        await gate;
        return { accessToken: `token-${issued}`, expiresAtMs: Date.now() + 3_600_000 };
      },
    };
    const provider = createGcpSecretManagerProvider({ config: TEST_CONFIG, tokenSource });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ payload: { data: base64("value") } }), { status: 200 }),
    );
    const resolve = () =>
      provider.resolveVersion({
        material: {
          scheme: "gcp_secret_manager_v1",
          externalRef: "projects/my-project/secrets/db-password",
          providerVersionRef: null,
          source: "external_reference",
        },
        externalRef: "projects/my-project/secrets/db-password",
      });

    const pending = Promise.all([resolve(), resolve(), resolve()]);
    release?.();
    await pending;

    expect(issued).toBe(1);
  });

  it("reports descriptor().configured from the credentials that resolve", async () => {
    expect(createGcpSecretManagerProvider().descriptor().configured).toBe(false);

    process.env.PAPERCLIP_SECRETS_GCP_PROJECT_ID = "my-project";
    expect(createGcpSecretManagerProvider().descriptor().configured).toBe(false);

    process.env.PAPERCLIP_SECRETS_GCP_ACCESS_TOKEN = "ya29.test-token";
    expect(createGcpSecretManagerProvider().descriptor().configured).toBe(true);

    delete process.env.PAPERCLIP_SECRETS_GCP_PROJECT_ID;
    expect(createGcpSecretManagerProvider().descriptor().configured).toBe(false);
  });

  it("reports a warning rather than an error when no project is configured", async () => {
    const provider = createGcpSecretManagerProvider({ gateway: unusedGateway() });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const health = await provider.healthCheck();

    expect(health.status).toBe("warn");
    expect(health.message).toContain("is not ready");
    expect(health.message).toContain("PAPERCLIP_SECRETS_GCP_PROJECT_ID");
    expect(health.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Google application default credentials must be available"),
        expect.stringContaining("Do not store Google service-account keys"),
      ]),
    );
    // An unconfigured provider is health-checked on every deployment and must not
    // reach for the credential chain to answer.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports ok once the credentials resolve, without listing secrets", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      tokenSource: staticTokenSource(),
      gateway: unusedGateway(),
    });

    const health = await provider.healthCheck();

    expect(health.status).toBe("ok");
    expect(health.details).toMatchObject({ projectId: "my-project" });
    expect(JSON.stringify(health)).not.toContain("test-access-token");
  });

  it("reports an error when configured credentials cannot be acquired", async () => {
    const provider = createGcpSecretManagerProvider({
      config: TEST_CONFIG,
      gateway: unusedGateway(),
      tokenSource: {
        async fetchAccessToken() {
          throw new Error("Google application default credentials are unavailable: fetch failed");
        },
      },
    });

    const health = await provider.healthCheck();

    expect(health.status).toBe("error");
    expect(health.message).toContain("could not acquire Google application default credentials");
  });
});
