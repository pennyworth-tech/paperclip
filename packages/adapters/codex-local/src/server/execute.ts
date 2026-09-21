import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildCodexAuthInboundProvision } from "./codex-auth-merge-scripts.js";
import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import {
  ensureCodexAuthCacheEntryDir,
  isCodexAuthCacheEnabled,
  resolveCodexAuthCacheEntryPath,
  selectVendCredential,
} from "./codex-auth-cache.js";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildLlmAttributionTags,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessSandboxExtraPaths,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  type LocalProcessSandboxOptions,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  parseCodexJsonl,
  classifyCodexAuthRefreshFailure,
  extractCodexRetryNotBefore,
  isCodexHarnessCrash,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import {
  codexHomeHasUsableAuth,
  evaluateCodexCredentialReadiness,
  isManagedCodexHomePath,
  pathExists,
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
  resolveSharedCodexHomeDir,
  seedManagedCodexHome,
  stageCodexHomeForSync,
  mergeManagedCodexMcpGateways,
  writeManagedCodexMcpConfig,
  type ManagedCodexMcpGateway,
} from "./codex-home.js";
import {
  CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
  resolveCodexAuthPrecedence,
} from "./auth-precedence.js";
import {
  SESSION_CHECKPOINT_EVENT_TYPE,
  SESSION_RECOVERY_EVENT_TYPE,
  createStreamSessionIdLatch,
  type SessionCheckpointPayload,
  type SessionRecoveryPayload,
} from "@paperclipai/adapter-utils/session-checkpoint";
import { prepareCodexRuntimeConfig } from "./runtime-config.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
  resolveCodexInactivityTimeout,
} from "./output-inactivity-monitor.js";
import {
  CODEX_PROCESS_ACTIVITY_POLL_INTERVAL_MS,
  createCodexProcessActivityMonitor,
  type CodexProcessActivityMonitorHandle,
} from "./process-activity-monitor.js";
import {
  createCodexAcpExecutor,
  formatCodexAcpFallbackMessage,
  resolveCodexExecutionEngineForRun,
} from "./acp.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeCodexAcp = createCodexAcpExecutor();
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// Benign stderr lines that never explain a nonzero exit and must not be
// surfaced as the run error: Codex always prints the YOLO approvals warning
// because this adapter passes the approvals-bypass flag itself, and
// "[paperclip] ..." lines are diagnostics the adapter injected (e.g. ACP
// fallback notes). Keep this list conservative so real errors are never
// skipped.
const BENIGN_CODEX_STDERR_LINE_RES: readonly RegExp[] = [
  /^YOLO mode is enabled\b/i,
  /^\[paperclip\]/,
];

function isBenignCodexStderrLine(line: string): boolean {
  return BENIGN_CODEX_STDERR_LINE_RES.some((re) => re.test(line));
}

export function firstMeaningfulStderrLine(text: string): string {
  const meaningful = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !isBenignCodexStderrLine(line));
  return meaningful ?? firstNonEmptyLine(text);
}

function signalCodexChild(
  target: { pid: number | null; processGroupId: number | null },
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
    try {
      process.kill(-target.processGroupId, signal);
      return true;
    } catch {
      // Fall back to direct child signal if group signaling fails (e.g. group already gone).
    }
  }
  if (target.pid && target.pid > 0) {
    try {
      process.kill(target.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyPaperclipRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyPaperclipRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyPaperclipRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailablePaperclipSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  linkSkill?: (source: string, target: string) => Promise<void>;
};

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

function readCodexTransientFallbackMode(context: Record<string, unknown>): CodexTransientFallbackMode | null {
  const value = asString(context.codexTransientFallbackMode, "").trim();
  switch (value) {
    case "same_session":
    case "safer_invocation":
    case "fresh_session":
    case "fresh_session_safer_invocation":
      return value;
    default:
      return null;
  }
}

function fallbackModeUsesSaferInvocation(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "safer_invocation" || mode === "fresh_session_safer_invocation";
}

function fallbackModeUsesFreshSession(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "fresh_session" || mode === "fresh_session_safer_invocation";
}

function managedMcpGatewaysFromContext(context: Record<string, unknown>): ManagedCodexMcpGateway[] {
  const managedMcp = parseObject(context.paperclipManagedMcp);
  if (managedMcp.managedMcpOnly !== true) return [];
  const gateways = Array.isArray(managedMcp.gateways) ? managedMcp.gateways : [];
  return gateways
    .map((raw): ManagedCodexMcpGateway | null => {
      const gateway = parseObject(raw);
      const name = asString(gateway.name, "").trim();
      const endpointPath = asString(gateway.endpointPath, "").trim();
      const bearerToken = asString(gateway.bearerToken, "").trim();
      if (!name || !endpointPath || !bearerToken) return null;
      return { name, endpointPath, bearerToken };
    })
    .filter((gateway): gateway is ManagedCodexMcpGateway => Boolean(gateway));
}

type ResolvedExecutionTarget = ReturnType<typeof readAdapterExecutionTarget>;
type MaybeResolvedExecutionTarget = ResolvedExecutionTarget | undefined;

type SandboxCodexAuthProbeResult = "present" | "absent" | "unknown";

/**
 * Probe the sandbox for its own `~/.codex/auth.json`. "unknown" means the
 * probe itself failed (timeout, transport error, or a shell failure other
 * than `test`'s clean false) — callers that gate on the result must not
 * report that as a missing credential.
 */
async function probeSandboxCodexAuthJson(input: {
  runId: string;
  target: MaybeResolvedExecutionTarget;
  cwd: string;
}): Promise<SandboxCodexAuthProbeResult> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return "absent";
  }

  try {
    const result = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
      {
        cwd: input.cwd,
        env: {},
        timeoutSec: 5,
      },
    );
    if (result.timedOut) return "unknown";
    if (result.exitCode === 0) return "present";
    return result.exitCode === 1 ? "absent" : "unknown";
  } catch {
    return "unknown";
  }
}

async function sandboxCodexAuthJsonExists(input: {
  runId: string;
  target: MaybeResolvedExecutionTarget;
  cwd: string;
}): Promise<boolean> {
  return (await probeSandboxCodexAuthJson(input)) === "present";
}

/**
 * Execute-time credential gate. A managed home with no host-side credentials
 * is still launchable when the run targets a sandbox whose image carries its
 * own Codex login (`~/.codex/auth.json` baked in during image setup): the
 * inbound auth merge ships the credential-less host home and keeps the
 * sandbox's credential, so the host is not a required credential source —
 * on managed cloud hosts a local Codex login never exists at all. The
 * sandbox is probed before the run is declared unlaunchable; non-sandbox
 * targets keep the strict host-side requirement.
 */
export async function assertCodexCredentialsLaunchable(input: {
  runId: string;
  companyId: string;
  configuredCodexHome: string | null;
  configuredApiKey: string | null;
  effectiveCodexHome: string;
  target: MaybeResolvedExecutionTarget;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<void> {
  const credentialReadiness = await evaluateCodexCredentialReadiness({
    env: input.env ?? process.env,
    companyId: input.companyId,
    configuredCodexHome: input.configuredCodexHome,
    configuredApiKey: input.configuredApiKey,
  });
  if (!credentialReadiness.managed || credentialReadiness.ready) return;

  const targetIsSandbox =
    input.target?.kind === "remote" && input.target.transport === "sandbox";
  if (targetIsSandbox) {
    const sandboxAuthJson = await probeSandboxCodexAuthJson({
      runId: input.runId,
      target: input.target,
      cwd: input.cwd,
    });
    if (sandboxAuthJson === "present") {
      await input.onLog(
        "stdout",
        `Using the sandbox's own Codex login; managed home "${input.effectiveCodexHome}" has no host credentials.\n`,
      );
      return;
    }
    if (sandboxAuthJson === "unknown") {
      // The probe failing is an operational problem, not evidence that the
      // sandbox lacks a login — proceeding lets a genuinely credentialed
      // sandbox run, and a credential-less one still fails at Codex's first
      // request with the provider's own error.
      await input.onLog(
        "stderr",
        `Could not verify the sandbox's Codex login (probe failed); proceeding. ` +
          `If the sandbox has no credentials, Codex will fail at its first request.\n`,
      );
      return;
    }
    throw new Error(
      `no Codex credentials provisioned for managed home "${input.effectiveCodexHome}" ` +
        `(no usable auth.json, OPENAI_API_KEY is empty, and the sandbox has no Codex login). ` +
        `Use a sandbox image that is signed in to Codex, configure a per-agent OPENAI_API_KEY, ` +
        `or sign in to Codex on the host with a ChatGPT subscription.`,
    );
  }

  throw new Error(
    `no Codex credentials provisioned for managed home "${input.effectiveCodexHome}" ` +
      `(no usable auth.json and OPENAI_API_KEY is empty). ` +
      `Sign in to Codex on the host with a ChatGPT subscription, or configure a per-agent ` +
      `OPENAI_API_KEY.`,
  );
}

async function emitSandboxAuthPrecedenceWarningIfNeeded(input: {
  runId: string;
  target: MaybeResolvedExecutionTarget;
  cwd: string;
  configuredApiKey: boolean;
  hostAuthJson: boolean;
  onLog: AdapterExecutionContext["onLog"];
  onEvent: AdapterExecutionContext["onEvent"];
}): Promise<void> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return;
  }

  const sandboxAuthJson = await sandboxCodexAuthJsonExists({
    runId: input.runId,
    target: input.target,
    cwd: input.cwd,
  });
  const resolution = resolveCodexAuthPrecedence({
    configuredApiKey: input.configuredApiKey,
    hostAuthJson: input.hostAuthJson,
    sandboxAuthJson,
  });
  if (!resolution.shouldWarn) return;

  await input.onLog("stderr", CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE);
  await input.onEvent?.({
    eventType: "codex.auth_precedence_warning",
    stream: "system",
    level: "warn",
    message: CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
    payload: {
      configuredApiKey: input.configuredApiKey,
      hostAuthJson: input.hostAuthJson,
      sandboxAuthJson,
      winner: resolution.winner,
      sandboxLoginShadowed: resolution.sandboxLoginShadowed,
    },
  });
}

function buildCodexTransientHandoffNote(input: {
  previousSessionId: string | null;
  fallbackMode: CodexTransientFallbackMode;
  continuationSummaryBody: string | null;
}): string {
  return [
    "Paperclip session handoff:",
    input.previousSessionId ? `- Previous session: ${input.previousSessionId}` : "",
    "- Rotation reason: repeated Codex transient remote-compaction failures",
    `- Fallback mode: ${input.fallbackMode}`,
    input.continuationSummaryBody
      ? `- Issue continuation summary: ${input.continuationSummaryBody.slice(0, 1_500)}`
      : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries
    ?? (await readPaperclipRuntimeSkillEntries({}, __moduleDir)).filter(
      (entry) => !isPaperclipSkillSourceMissing(entry),
    );
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[paperclip] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailablePaperclipSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const engineSelection = await resolveCodexExecutionEngineForRun(ctx);
  if (engineSelection.engine === "acp") {
    try {
      return await executeCodexAcp(ctx);
    } catch (err) {
      if (engineSelection.explicit) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stderr",
        formatCodexAcpFallbackMessage(`Codex ACP startup failed: ${reason}`),
      );
    }
  }
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    await ctx.onLog("stderr", formatCodexAcpFallbackMessage(engineSelection.fallbackReason));
  }

  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const targetWorkspaceRealization = executionTarget?.workspaceRealization ?? null;
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = targetWorkspaceRealization?.mode === "in_place"
    ? targetWorkspaceRealization.authoritativeRoot
    : useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = (await readPaperclipRuntimeSkillEntries(config, __moduleDir))
    // A missing-source entry would become a dangling skill symlink; skip it.
    .filter((entry) => !isPaperclipSkillSourceMissing(entry));
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  }
  const configuredOpenAiApiKey =
    typeof envConfig.OPENAI_API_KEY === "string" && envConfig.OPENAI_API_KEY.trim().length > 0
      ? envConfig.OPENAI_API_KEY.trim()
      : null;
  // A configured CODEX_HOME that lives under the Paperclip-managed company tree
  // (the per-agent home set by the server isolation guard) still needs auth
  // seeded — it ships with no credentials and OPENAI_API_KEY="" by default.
  // Only a genuine external/user-supplied override is treated as self-managed
  // and left untouched.
  const configuredHomeIsManaged =
    configuredCodexHome != null &&
    isManagedCodexHomePath(process.env, agent.companyId, configuredCodexHome);
  // Identity-anchored cache vend (host to sandbox). Before the managed home is
  // seeded from the shared source `auth.json`, refresh the shared credential with
  // a strictly-newer cached copy of the SAME identity. The vend reads the host
  // identity first and resolves only that identity's cache slot; when the host
  // holds no credential it does nothing (no random pick). This keeps the change
  // additive: the managed home still symlinks the shared `auth.json`, now at its
  // freshest same-identity copy. The off-switch (default on) skips the vend.
  if (isCodexAuthCacheEnabled(process.env)) {
    const sharedHomeAuthPath = path.join(resolveSharedCodexHomeDir(process.env), "auth.json");
    // This caller reads `process.env` directly and holds no separate `env`
    // object, so `selectVendCredential` falls back to its own `process.env`
    // default for the merge lock root.
    await selectVendCredential(
      sharedHomeAuthPath,
      (accountId) => resolveCodexAuthCacheEntryPath(process.env, accountId, agent.companyId),
      (line) => onLog("stdout", `${line}\n`),
    ).catch(async (error) => {
      // The vend is best-effort and additive. A vend failure must never block a
      // run: log and fall through to seed from the unrefreshed shared credential.
      await onLog(
        "stderr",
        `[paperclip] Codex auth cache: vend skipped after an error; using the shared credential as-is.\n`,
      );
      void error;
    });
  }
  if (configuredCodexHome == null) {
    await prepareManagedCodexHome(process.env, onLog, agent.companyId, {
      apiKey: configuredOpenAiApiKey,
    });
  } else if (configuredHomeIsManaged) {
    await seedManagedCodexHome(configuredCodexHome, process.env, onLog, {
      apiKey: configuredOpenAiApiKey,
    });
  }
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });

  // Never launch a managed CODEX_HOME with no credentials. Without auth.json
  // and with OPENAI_API_KEY="" the provider rejects every request with
  // "401 Missing bearer"; fail fast with a clear adapter error instead of
  // emitting unauthenticated calls. External overrides manage their own auth.
  // This is the execute-time backstop for the control plane's pre-dispatch
  // configuration-incomplete gate (see server heartbeat); both decide host
  // readiness through the same `evaluateCodexCredentialReadiness` predicate,
  // and sandbox targets are additionally allowed to supply their own login
  // (the pre-dispatch gate defers sandbox-destined runs here for exactly that
  // probe).
  await assertCodexCredentialsLaunchable({
    runId,
    companyId: agent.companyId,
    configuredCodexHome,
    configuredApiKey: configuredOpenAiApiKey,
    effectiveCodexHome,
    target: executionTarget,
    cwd,
    onLog,
  });
  // Merge custom model providers (PAPERCLIP_CODEX_PROVIDERS) into the managed
  // CODEX_HOME's config.toml BEFORE the home is shipped to a remote execution
  // target, so both local and sandboxed Codex processes pick up the routing.
  // An explicit env.CODEX_HOME override is treated as user-managed and skipped.
  const envConfigStrings = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const preparedRuntimeConfig = await prepareCodexRuntimeConfig({
    env: envConfigStrings,
    codexHome: configuredCodexHome ? null : effectiveCodexHome,
  });
  // Curated allowlist dir staged for the remote `home` asset (see below). Held
  // here so the outer `finally` can remove it on every exit path (teardown and
  // error), never only the happy path.
  let stagedCodexHomeDir: string | null = null;
  try {
    for (const note of preparedRuntimeConfig.notes) {
      await onLog("stdout", `[paperclip] ${note}\n`);
    }
    const paperclipBaseEnv = buildPaperclipEnv(agent);
    const runtimeMcpGateways = (ctx.runtimeMcp?.getServers() ?? []).map((server) => ({
      name: server.name,
      endpointPath: server.url,
      bearerToken: server.token,
    }));
    const managedMcpGateways = mergeManagedCodexMcpGateways(
      runtimeMcpGateways,
      managedMcpGatewaysFromContext(context),
    );
    const managedMcp = await writeManagedCodexMcpConfig({
      codexHome: effectiveCodexHome,
      apiBaseUrl: paperclipBaseEnv.PAPERCLIP_API_URL,
      gateways: managedMcpGateways,
    });
    if (managedMcpGateways.length > 0) {
      await onLog(
        "stdout",
        `[paperclip] Wrote ${managedMcpGateways.length} managed MCP gateway(s) into Codex config "${managedMcp.configPath}".\n`,
      );
    }
    for (const warning of managedMcp.warnings) {
      await onLog("stderr", `[paperclip] ${warning}\n`);
    }
    // Inject skills into the same CODEX_HOME that Codex will actually run with
    // (managed home in the default case, or an explicit override from adapter config).
    const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
    await ensureCodexSkillsInjected(
      onLog,
      {
        skillsHome: codexSkillsDir,
        skillsEntries: codexSkillEntries,
        desiredSkillNames,
      },
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    let effectiveExecutionCwd = targetWorkspaceRealization?.mode === "in_place"
      ? targetWorkspaceRealization.authoritativeRoot
      : adapterExecutionTargetRemoteCwd(executionTarget, cwd);
    const preparedExecutionTargetRuntime = executionTargetIsRemote
      ? await (async () => {
          await onLog(
            "stdout",
            `[paperclip] Syncing ${targetWorkspaceRealization?.mode === "in_place" ? "CODEX_HOME" : "workspace and CODEX_HOME"} to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
          );
          // Stage only the files Codex actually needs into a curated temp dir and
          // ship THAT as the `home` asset, instead of the whole managed
          // CODEX_HOME + a name denylist. Staged AFTER the config.toml rewrites
          // (provider merge + MCP block splice above) and skills injection, so the
          // staged config.toml/skills reflect their final state. Symlinks (incl.
          // the single-use `auth.json`) are dereferenced to bytes. This drops the
          // large runtime state (`sessions/`, `*.sqlite`, `plugins/`, …) that the
          // 4-name denylist missed and that a sandbox run never needs.
          stagedCodexHomeDir = await stageCodexHomeForSync(effectiveCodexHome, { runId });
          return await prepareAdapterExecutionTargetRuntime({
            runId,
            target: executionTarget,
            adapterKey: "codex",
            timeoutSec,
            workspaceLocalDir: cwd,
            workspaceRemoteDir:
              targetWorkspaceRealization?.mode === "in_place"
                ? targetWorkspaceRealization.authoritativeRoot
                : undefined,
            syncWorkspace: targetWorkspaceRealization?.mode !== "in_place",
            installCommand: SANDBOX_INSTALL_COMMAND,
            detectCommand: command,
            onProgress: (line) => onLog("stdout", line),
            onRuntimeProgress: ctx.onRuntimeProgress,
            assets: [
              {
                key: "home",
                localDir: stagedCodexHomeDir,
                followSymlinks: true,
                // Inbound (host→sandbox) auth-merge contribution: stages the two
                // merge scripts and runs the merge-extract command so a sandbox
                // that already carries a Codex `auth.json` keeps whichever
                // credential is newer. The sandbox runtime core stays adapter-
                // agnostic — it just invokes this generic `provision` seam.
                provision: buildCodexAuthInboundProvision(),
                // Outbound (sandbox→host) auth copy-back contribution: at
                // teardown, read the sandbox's `auth.json` and — guarded by the
                // same direction-agnostic decision predicate under a directory
                // lock — atomically install it onto the shared host credential
                // when it is a strictly-newer same-identity subscription copy.
                // The sandbox core stays adapter-agnostic; it just awaits this
                // generic `restore` seam per asset before destroying the sandbox.
                // Target is the shared symlink SOURCE (what managed homes point
                // `auth.json` at), not the in-sandbox symlink.
                restore: async ({ assetDir, readFile }) =>
                  void (await copyBackCodexAuth({
                    readSandboxAuth: () => readFile(path.posix.join(assetDir, "auth.json")),
                    hostAuthPath: path.join(resolveSharedCodexHomeDir(process.env), "auth.json"),
                    log: (line) => onLog("stdout", `${line}\n`),
                    // Additive cache write (sandbox to host): also cache the
                    // sandbox subscription credential in its per-identity slot,
                    // keyed by the real `account_id`. Company-scoped root; the
                    // helper ensures the slot directory private and containment-
                    // guarded. The off-switch (default on) is read inside.
                    resolveCacheEntryPath: (accountId) =>
                      ensureCodexAuthCacheEntryDir(process.env, accountId, agent.companyId),
                    env: process.env,
                  })),
                // No `exclude` denylist: `stagedCodexHomeDir` already contains
                // ONLY the allowlisted files (auth/config/skills), so there is
                // nothing to filter out.
              },
            ],
          });
        })()
      : null;
    if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    const executionTargetIsSandbox =
      runtimeExecutionTarget?.kind === "remote" && runtimeExecutionTarget.transport === "sandbox";
    const restoreRemoteWorkspace = preparedExecutionTargetRuntime
      ? () => preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line))
      : null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
    const remoteCodexHome = executionTargetIsRemote
      ? preparedExecutionTargetRuntime?.assetDirs.home ??
        path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "codex", "home")
      : null;
    await emitSandboxAuthPrecedenceWarningIfNeeded({
      runId,
      target: runtimeExecutionTarget,
      cwd: effectiveExecutionCwd,
      configuredApiKey: Boolean(configuredOpenAiApiKey),
      hostAuthJson: await codexHomeHasUsableAuth(effectiveCodexHome),
      onLog,
      onEvent,
    });
    const env: Record<string, string> = { ...paperclipBaseEnv };
    env.PAPERCLIP_RUN_ID = runId;
    const wakeTaskId =
      (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
      (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
      null;
    const wakeReason =
      typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
        ? context.wakeReason.trim()
        : null;
    const wakeCommentId =
      (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
      (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
      null;
    const approvalId =
      typeof context.approvalId === "string" && context.approvalId.trim().length > 0
        ? context.approvalId.trim()
        : null;
    const approvalStatus =
      typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
        ? context.approvalStatus.trim()
        : null;
    const linkedIssueIds = Array.isArray(context.issueIds)
      ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) {
      env.PAPERCLIP_TASK_ID = wakeTaskId;
    }
    if (issueWorkMode) {
      env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    }
    if (wakeReason) {
      env.PAPERCLIP_WAKE_REASON = wakeReason;
    }
    if (wakeCommentId) {
      env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    }
    if (approvalId) {
      env.PAPERCLIP_APPROVAL_ID = approvalId;
    }
    if (approvalStatus) {
      env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    }
    if (linkedIssueIds.length > 0) {
      env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    }
    if (wakePayloadJson) {
      env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
    }
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceStrategy,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceBranch,
      workspaceWorktreePath,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    // Per-run LLM gateway attribution; after the config env so a static
    // adapter value cannot override it. A provider that should send it reads
    // the variable from its own process env at request time
    // (`env_http_headers`), so the managed config.toml needs no placeholder.
    env.LITELLM_TAGS = buildLlmAttributionTags({ agent, context });
    if (targetWorkspaceRealization) {
      env.PAPERCLIP_WORKSPACE_REALIZATION_MODE = targetWorkspaceRealization.mode;
      env.PAPERCLIP_WORKSPACE_AUTHORITATIVE_ROOT = targetWorkspaceRealization.authoritativeRoot;
    }
    if (runtimeServiceIntents.length > 0) {
      env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
    }
    if (runtimeServices.length > 0) {
      env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
    }
    if (runtimePrimaryUrl) {
      env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
    }
    env.CODEX_HOME = remoteCodexHome ?? effectiveCodexHome;
    if (authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
        adapterKey: "codex",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
      }
    }
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const billingType = resolveCodexBillingType(effectiveEnv);
    const networkScope = parseLocalProcessNetworkScope(config.networkScope);
    const filesystemScope = parseLocalProcessFilesystemScope(config.filesystemScope);
    const localProcessSandbox: LocalProcessSandboxOptions | null =
      (filesystemScope || networkScope) && !executionTargetIsRemote
        ? {
            workspaceDir: effectiveExecutionCwd,
            filesystemScope,
            managedPaths: [{ path: effectiveCodexHome, access: "rw" }],
            extraPaths: parseLocalProcessSandboxExtraPaths(config.filesystemExtraPaths),
            pathAliases: targetWorkspaceRealization?.mode === "copy"
              ? targetWorkspaceRealization.pathAliases
              : [],
            outboundRestorePaths: targetWorkspaceRealization?.outboundRestorePaths ?? [],
            homeDir: filesystemScope ? effectiveCodexHome : null,
            networkScope,
            networkAllowlist: parseLocalProcessNetworkAllowlist(config.networkAllowlist),
            networkTrustedUrls: [
              paperclipBaseEnv.PAPERCLIP_API_URL,
              ...runtimeMcpGateways.map((gateway) => gateway.endpointPath),
            ],
            command: asString(config.filesystemSandboxCommand, "bwrap"),
          }
        : null;
    if (localProcessSandbox) {
      const scopes = [filesystemScope ? "workspace filesystem" : null, networkScope ? `${networkScope} network` : null]
        .filter(Boolean)
        .join(" and ");
      await onLog(
        "stdout",
        `[paperclip] Confining Codex with ${scopes} scope.\n`,
      );
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv(effectiveEnv)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    const monitorResolution = resolveCodexInactivityTimeout(config.outputInactivityTimeoutMs);
    if (monitorResolution.mode === "disabled") {
      await onLog(
        "stdout",
        `[paperclip] Codex output inactivity monitor is DISABLED via adapterConfig.outputInactivityTimeoutMs=null. Hung codex runs will only be detected by the platform-level silent-run safety net.\n`,
      );
    } else if (monitorResolution.mode === "default" && "reason" in monitorResolution) {
      await onLog(
        "stdout",
        `[paperclip] Ignoring non-positive adapterConfig.outputInactivityTimeoutMs; falling back to default ${monitorResolution.timeoutMs}ms.\n`,
      );
    }
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const codexTransientFallbackMode = readCodexTransientFallbackMode(context);
    const forceSaferInvocation = fallbackModeUsesSaferInvocation(codexTransientFallbackMode);
    const forceFreshSession = fallbackModeUsesFreshSession(codexTransientFallbackMode);
    const sessionId = canResumeSession && !forceFreshSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Codex session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    let instructionsChars = 0;
    if (instructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${instructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
        instructionsChars = instructionsPrefix.length;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
        );
      }
    }
    const repoAgentsNote =
      "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.";
    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedBootstrapPrompt =
      !sessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
    instructionsChars = promptInstructionsPrefix.length;
    const continuationSummary = parseObject(context.paperclipContinuationSummary);
    const continuationSummaryBody = asString(continuationSummary.body, "").trim() || null;
    const codexFallbackHandoffNote =
      forceFreshSession
        ? buildCodexTransientHandoffNote({
            previousSessionId: runtimeSessionId || runtime.sessionId || null,
            fallbackMode: codexTransientFallbackMode ?? "fresh_session",
            continuationSummaryBody,
          })
        : "";
    const commandNotes = (() => {
      if (!instructionsFilePath) {
        const notes = [repoAgentsNote];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      if (instructionsPrefix.length > 0) {
        if (shouldUseResumeDeltaPrompt) {
          const notes = [
            `Loaded agent instructions from ${instructionsFilePath}`,
            "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
            repoAgentsNote,
          ];
          if (forceSaferInvocation) {
            notes.push("Codex transient fallback requested safer invocation settings for this retry.");
          }
          if (forceFreshSession) {
            notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
          }
          return notes;
        }
        const notes = [
          `Loaded agent instructions from ${instructionsFilePath}`,
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
          repoAgentsNote,
        ];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      const notes = [
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        repoAgentsNote,
      ];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    })();
    if (executionTargetIsSandbox) {
      commandNotes.push(
        "Added --skip-git-repo-check for sandbox execution because Codex requires an explicit trust bypass in headless remote workspaces.",
      );
    }
    if (preparedRuntimeConfig.notes.length > 0) {
      commandNotes.unshift(...preparedRuntimeConfig.notes);
    }
    const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const prompt = joinPromptSections([
      promptInstructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      codexFallbackHandoffNote,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    // Why the recorded session is not being resumed, in the same words the logs
    // above already use. This is the `reason` on the `session.recovery` event.
    const freshSessionReason = sessionId
      ? null
      : !runtimeSessionId
      ? "No Codex session was recorded for this task"
      : forceFreshSession
      ? `Codex transient fallback forced a fresh session away from "${runtimeSessionId}"`
      : `Recorded Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" or a different execution target, not "${effectiveExecutionCwd}"`;

    // Hoisted out of the finalization path so the provisional checkpoint and the
    // final AdapterExecutionResult persist one shape. Codex records
    // `effectiveExecutionCwd` (not `cwd`); that is pre-existing and left alone.
    const buildSessionParams = (sessionIdForParams: string): Record<string, unknown> => ({
      sessionId: sessionIdForParams,
      cwd: effectiveExecutionCwd,
      ...(executionTargetIsRemote
        ? {
            remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
          }
        : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
    });

    // Fire-and-forget by design. The checkpoint is emitted from inside the
    // stdout path, and awaiting it would apply backpressure to the child: the
    // process runner pauses the readable and serializes every onLog call
    // through its logChain before resuming. The `.catch` is not optional — an
    // unhandled rejection from the host sink would take the whole process down.
    const emitSessionCheckpoint = (payload: SessionCheckpointPayload) => {
      void onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        stream: "system",
        payload: { ...payload },
      })?.catch(() => {
        // The checkpoint is provisional; losing one costs a resume, not the run.
      });
    };

    // Recovery events are emitted once per run, off the stdout hot path, so
    // they are awaited normally.
    const emitSessionRecovery = async (payload: SessionRecoveryPayload) => {
      if (!onEvent) return;
      await onEvent({
        eventType: SESSION_RECOVERY_EVENT_TYPE,
        stream: "system",
        payload: { ...payload },
      });
    };

    const runAttempt = async (
      resumeSessionId: string | null,
      attempt: number,
      freshReason: string | null,
    ) => {
      // Codex never lets the caller name the session — `codex exec --json`
      // assigns a thread id and announces it in a `thread.started` event. The
      // earliest moment the id exists is therefore the first stdout chunk, and
      // that is where it gets checkpointed: waiting for the child to exit
      // loses hours of real conversation whenever the process is killed.
      //
      // Scoped to the attempt, never outside it. The retry below runs attempt 1
      // with the recorded id and attempt 2 with a fresh thread; a latch that
      // outlived the attempt boundary would checkpoint the dead thread over the
      // live one.
      const latch = createStreamSessionIdLatch({
        parse: parseCodexJsonl,
        onSessionId: (streamSessionId) => {
          emitSessionCheckpoint({
            attempt,
            sessionId: streamSessionId,
            sessionParams: buildSessionParams(streamSessionId),
            // Harness-confirmed: codex named this thread in its own stream, so
            // the thread demonstrably exists and a later absence is outcome 3.
            source: "stream",
          });
        },
      });
      if (!resumeSessionId) {
        await emitSessionRecovery({
          outcome: runtimeSessionId ? "fresh_missing" : "fresh_none",
          sessionId: runtimeSessionId || null,
          reason: freshReason ?? "No Codex session was recorded for this task",
        });
      }
      const execArgs = buildCodexExecArgs(
        forceSaferInvocation ? { ...config, fastMode: false } : config,
        {
          resumeSessionId,
          skipGitRepoCheck: executionTargetIsSandbox,
        },
      );
      const args = execArgs.args;
      const commandNotesWithFastMode =
        execArgs.fastModeIgnoredReason == null
          ? commandNotes
          : [...commandNotes, execArgs.fastModeIgnoredReason];
      if (onMeta) {
        await onMeta({
          adapterType: "codex_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes: commandNotesWithFastMode,
          commandArgs: args.map((value, idx) => {
            if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
            return value;
          }),
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      let monitorFired = false;
      let monitorTerminationSignal: NodeJS.Signals | null = null;
      let monitorElapsedMs = 0;
      let monitorTimeoutMs = 0;
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let monitorLogPromise: Promise<unknown> | null = null;
      const processActivityMonitor: { current: CodexProcessActivityMonitorHandle | null } = { current: null };
      const resolvedMonitorTimeoutMs = monitorResolution.mode === "disabled" ? null : monitorResolution.timeoutMs;

      const monitor =
        monitorResolution.mode === "disabled"
          ? null
          : createCodexOutputInactivityMonitor({
              timeoutMs: monitorResolution.timeoutMs,
              onFire: (state) => {
                monitorFired = true;
                monitorElapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
                monitorTimeoutMs = monitorResolution.timeoutMs;
                const message = formatOutputInactivityMonitorErrorMessage(monitorElapsedMs);
                const elapsedSec = Math.round(monitorElapsedMs / 1000);
                const timeoutSecLabel = Math.round(monitorResolution.timeoutMs / 1000);
                const logLine =
                  `[paperclip] adapter.invoke ${message}; ` +
                  `timeoutMs=${monitorResolution.timeoutMs} elapsedSinceLastEventMs=${monitorElapsedMs} ` +
                  `outputChunkCount=${state.outputChunkCount} outputBytes=${state.outputBytes} ` +
                  `parsedEvents=${state.parsedEventCount} processActivityCount=${state.processActivityCount} ` +
                  `(timeout=${timeoutSecLabel}s elapsed=${elapsedSec}s); ` +
                  `terminating codex child via SIGTERM (5s grace, then SIGKILL).\n`;
                // Issue the log without awaiting on the kill hot path, but capture
                // the promise so the surrounding try/finally can await flush before
                // the run resolves. Without this the diagnostic that explains the
                // kill could be dropped if the child exits faster than onLog flushes.
                monitorLogPromise = Promise.resolve(onLog("stderr", logLine)).catch(() => {});
                const target = killTarget;
                if (!target || (target.pid == null && target.processGroupId == null)) {
                  return;
                }
                const sentSig = signalCodexChild(target, "SIGTERM");
                if (sentSig) monitorTerminationSignal = "SIGTERM";
                sigkillTimer = setTimeout(() => {
                  sigkillTimer = null;
                  const stillSent = signalCodexChild(target, "SIGKILL");
                  if (stillSent) monitorTerminationSignal = "SIGKILL";
                }, CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
                if (typeof (sigkillTimer as { unref?: () => void }).unref === "function") {
                  (sigkillTimer as { unref: () => void }).unref();
                }
              },
            });

      const wrappedOnSpawn = async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        killTarget = { pid: meta.pid ?? null, processGroupId: meta.processGroupId };
        if (monitor && resolvedMonitorTimeoutMs !== null && !executionTargetIsRemote) {
          processActivityMonitor.current = createCodexProcessActivityMonitor({
            pid: meta.pid,
            processGroupId: meta.processGroupId,
            intervalMs: Math.min(
              CODEX_PROCESS_ACTIVITY_POLL_INTERVAL_MS,
              Math.max(1_000, Math.floor(resolvedMonitorTimeoutMs / 4)),
            ),
            onActivity: () => monitor.noteProcessActivity(),
          });
        }
        if (onSpawn) {
          await onSpawn(meta);
        }
      };

      try {
        const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
          cwd,
          env,
          stdin: prompt,
          timeoutSec,
          graceSec,
          onSpawn: wrappedOnSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog: async (stream, chunk) => {
            monitor?.noteOutputChunk(stream, chunk);
            if (stream === "stdout") {
              latch.push(chunk);
              await onLog(stream, chunk);
              return;
            }
            const cleaned = stripCodexRolloutNoise(chunk);
            if (!cleaned.trim()) return;
            await onLog(stream, cleaned);
          },
          runLogTail: paperclipBridge?.runLogTail,
          settleRunDisposition: paperclipBridge?.settleRunDisposition,
          localProcessSandbox,
        });
        const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
        return {
          proc: {
            ...proc,
            stderr: cleanedStderr,
          },
          rawStderr: proc.stderr,
          parsed: parseCodexJsonl(proc.stdout),
          // The thread id as the latch saw it, carried out to finalization.
          // `proc.stdout` is only the last MAX_CAPTURE_BYTES of the stream, so
          // on any run long enough to matter the `thread.started` line has
          // scrolled off it and `parsed.sessionId` is null — including when the
          // run succeeds. The latch read it from the first chunk.
          streamSessionId: latch.sessionId,
          monitor: monitorFired
            ? {
                fired: true as const,
                terminationSignal: monitorTerminationSignal,
                elapsedMsSinceLastEvent: monitorElapsedMs,
                timeoutMs: monitorTimeoutMs,
              }
            : { fired: false as const },
        };
      } finally {
        processActivityMonitor.current?.stop();
        monitor?.stop();
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
        if (monitorLogPromise) {
          await monitorLogPromise;
          monitorLogPromise = null;
        }
      }
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parseCodexJsonl>;
        streamSessionId: string | null;
        monitor?:
          | { fired: false }
          | { fired: true; terminationSignal: NodeJS.Signals | null; elapsedMsSinceLastEvent: number; timeoutMs: number };
      },
      clearSessionOnMissingSession = false,
      isRetry = false,
    ): AdapterExecutionResult => {
      if (attempt.monitor?.fired) {
        // Same rule as the timeout branch below, and for the same reason. The
        // monitor kills a codex that has gone quiet, which is a run that may
        // have already named its thread and written turns to disk. Returning
        // three explicit nulls is not neutral: resolveNextSessionState falls
        // back to the pre-dispatch snapshot and writes it over the checkpoint
        // this run persisted mid-stream. On the retry lane it is worse still —
        // `clearSessionOnMissingSession` is true there, so the session is
        // cleared outright and the host-side rescue cannot reach it, because
        // `clearSession` wins by design.
        const monitorSessionId = attempt.streamSessionId;
        const errorMessage = formatOutputInactivityMonitorErrorMessage(attempt.monitor.elapsedMsSinceLastEvent);
        return {
          exitCode: null,
          signal: attempt.monitor.terminationSignal ?? attempt.proc.signal,
          timedOut: false,
          errorMessage,
          errorCode: "codex_output_inactivity_monitor",
          errorFamily: null,
          usage: attempt.parsed.usage,
          usageBasis: attempt.parsed.usageBasis,
          ...(monitorSessionId
            ? {
                sessionId: monitorSessionId,
                sessionParams: buildSessionParams(monitorSessionId),
                sessionDisplayId: monitorSessionId,
              }
            : { sessionId: null, sessionParams: null, sessionDisplayId: null }),
          provider: "openai",
          biller: resolveCodexBiller(effectiveEnv, billingType),
          model,
          billingType,
          costUsd: null,
          resultJson: {
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            outputInactivityMonitor: {
              kind: "output_inactivity",
              timeoutMs: attempt.monitor.timeoutMs,
              elapsedMsSinceLastEvent: attempt.monitor.elapsedMsSinceLastEvent,
              terminationSignal: attempt.monitor.terminationSignal,
            },
          },
          summary: attempt.parsed.summary,
          // Only clear when the harness genuinely never named a thread. A
          // stream-confirmed id is the thing worth keeping.
          clearSession: Boolean(clearSessionOnMissingSession && !monitorSessionId),
        };
      }
      if (attempt.proc.timedOut) {
        // Name the thread the attempt ran under. A result that names neither a
        // sessionId nor sessionParams is not neutral: resolveNextSessionState
        // falls back to the pre-dispatch snapshot and writes it over the
        // checkpoint this run persisted mid-stream, so a timeout — the common
        // case this mechanism exists for — would delete its own thread and the
        // retry would start cold. A null id means the harness never named a
        // thread, and then there is nothing to keep and today's shape stands.
        const timedOutSessionId = attempt.streamSessionId;
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          ...(timedOutSessionId
            ? {
                sessionId: timedOutSessionId,
                sessionParams: buildSessionParams(timedOutSessionId),
                sessionDisplayId: timedOutSessionId,
              }
            : {}),
          clearSession: Boolean(clearSessionOnMissingSession && !timedOutSessionId),
        };
      }

      const canFallbackToRuntimeSession = !isRetry && !forceFreshSession;
      // `attempt.parsed` reads the captured stdout TAIL; the latch read the
      // stream from its first byte. Preferring the parse keeps the existing
      // precedence, and the latch is what still holds the id once the
      // `thread.started` line has scrolled out of the 4 MB capture window.
      const resolvedSessionId =
        attempt.parsed.sessionId ??
        attempt.streamSessionId ??
        (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
      // The checkpoint above is PROVISIONAL: it fires the moment the thread id
      // appears in the stream, before anything is known about how the run ends.
      // This result stays authoritative — when it resolves to a null session id
      // it must still carry `clearSession` so the host drops a checkpoint the
      // run later invalidated.
      const resolvedSessionParams = resolvedSessionId ? buildSessionParams(resolvedSessionId) : null;
      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstMeaningfulStderrLine(attempt.proc.stderr);
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
      const transientRetryNotBefore =
        (attempt.proc.exitCode ?? 0) !== 0
          ? extractCodexRetryNotBefore({
              stdout: attempt.proc.stdout,
              stderr: attempt.proc.stderr,
              errorMessage: fallbackErrorMessage,
            })
          : null;
      const authRefreshFailure =
        (attempt.proc.exitCode ?? 0) !== 0
          ? classifyCodexAuthRefreshFailure({
              stdout: attempt.proc.stdout,
              stderr: attempt.proc.stderr,
              errorMessage: fallbackErrorMessage,
            })
          : null;
      const providerQuota =
        (attempt.proc.exitCode ?? 0) !== 0 &&
        !authRefreshFailure &&
        isCodexProviderQuotaError({
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientUpstream =
        (attempt.proc.exitCode ?? 0) !== 0 &&
        !authRefreshFailure &&
        !providerQuota &&
        isCodexTransientUpstreamError({
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const harnessCrash =
        !authRefreshFailure &&
        !providerQuota &&
        !transientUpstream &&
        isCodexHarnessCrash({
          exitCode: attempt.proc.exitCode,
          sawProtocolEvent: attempt.parsed.sawProtocolEvent,
          sawProtocolTerminalEvent: attempt.parsed.sawProtocolTerminalEvent,
        });
      const errorFamily =
        authRefreshFailure ??
        (providerQuota ? "provider_quota" : transientUpstream || harnessCrash ? "transient_upstream" : null);

      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage:
          (attempt.proc.exitCode ?? 0) === 0
            ? null
            : fallbackErrorMessage,
        errorCode:
          // Forward the transport-level error code from the run-disposition
          // seam first. A lost duplex control channel surfaces the typed
          // `duplex_channel_lost` code before any provider classification.
          attempt.proc.errorCode
            ? attempt.proc.errorCode
            : authRefreshFailure
            ? authRefreshFailure
            : providerQuota
            ? "provider_quota"
            : transientUpstream
            ? "codex_transient_upstream"
            : harnessCrash
            ? "codex_harness_crash"
            : null,
        errorFamily,
        retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
        usage: attempt.parsed.usage,
        usageBasis: attempt.parsed.usageBasis,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "openai",
        biller: resolveCodexBiller(effectiveEnv, billingType),
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          ...(errorFamily ? { errorFamily } : {}),
          ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
          ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
          ...(providerQuota && transientRetryNotBefore ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean((clearSessionOnMissingSession || forceFreshSession) && !resolvedSessionId),
      };
    };

    try {
      const initial = await runAttempt(sessionId, 1, freshSessionReason);
      if (
        sessionId &&
        !initial.proc.timedOut &&
        (initial.proc.exitCode ?? 0) !== 0 &&
        isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        // The resume itself failed, so this run's outcome is fresh_missing and
        // attempt 2 emits it — which is why attempt 1 emitted no recovery event
        // when it resumed. One recovery event per run, naming the lost thread.
        const retry = await runAttempt(
          null,
          2,
          `Recorded Codex session "${sessionId}" is unavailable to the harness`,
        );
        return toResult(retry, true, true);
      }

      if (sessionId) {
        // The resume attempt ran and the harness did not report the thread as
        // unknown: outcome 2, the conversation survived. Emitted here rather
        // than at spawn because "resumed" is only knowable once the harness has
        // accepted the id.
        await emitSessionRecovery({
          outcome: "resumed",
          sessionId,
          reason: `Resumed Codex session "${sessionId}" in "${effectiveExecutionCwd}"`,
        });
      }

      return toResult(initial, false, false);
    } finally {
      if (paperclipBridge) {
        await paperclipBridge.stop();
      }
      if (restoreRemoteWorkspace) {
        // This teardown runs in a `finally`, so a throw here replaces the
        // already-computed run result (`return toResult(...)`) and turns a
        // successful Codex run into a failure. The workspace restore — and the
        // host credential copy-back inside it — is a best-effort teardown step.
        // Keep it rejection-safe: log a fault loudly and keep the pending
        // result. The host copy-back installs the credential on disk before any
        // diagnostic log runs, so it is already durable when this block returns.
        try {
          await onLog(
            "stdout",
            `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
          );
          await restoreRemoteWorkspace();
        } catch (error) {
          await Promise.resolve(
            onLog(
              "stderr",
              `[paperclip] Failed to restore workspace changes from ${describeAdapterExecutionTarget(
                executionTarget,
              )}: ${error instanceof Error ? error.message : String(error)}\n`,
            ),
          ).catch(() => undefined);
        }
      }
    }
  } finally {
    // Remove the staged CODEX_HOME allowlist temp dir on every exit path
    // (teardown AND error), never only the happy path. Cleanup failure is
    // logged, not fatal — a leaked temp dir must not crash the run.
    if (stagedCodexHomeDir) {
      await fs.rm(stagedCodexHomeDir, { recursive: true, force: true }).catch(async (error) => {
        await onLog(
          "stderr",
          `[paperclip] Failed to remove staged Codex home "${stagedCodexHomeDir}": ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    // Restore the managed config.toml so PAPERCLIP_CODEX_PROVIDERS changes
    // (or removal) between runs never leave stale provider routing behind. This
    // finally starts the moment prepareCodexRuntimeConfig returns, so a throw
    // anywhere in the remaining setup (skill injection, remote runtime
    // preparation, command building) restores the original config.toml too.
    // If the process dies before reaching this, the next
    // prepareCodexRuntimeConfig restores the original from the pre-run backup
    // written at prepare time.
    await preparedRuntimeConfig.cleanup();
  }
}
