import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
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
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  applyPaperclipWorkspaceEnv,
  buildPaperclipEnv,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  selectPaperclipTaskMarkdown,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  SESSION_CHECKPOINT_EVENT_TYPE,
  SESSION_RECOVERY_EVENT_TYPE,
  buildClaudeTranscriptProbePath,
  createStreamSessionIdLatch,
  type SessionCheckpointPayload,
  type SessionRecoveryPayload,
} from "@paperclipai/adapter-utils/session-checkpoint";
import { buildSkillLibraryManifestMarkdown } from "@paperclipai/adapter-utils/skill-library-manifest";
import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessSandboxExtraPaths,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  type LocalProcessSandboxOptions,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  claudeModelUsageTotals,
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeMaxTurnsResult,
  isClaudeProviderQuotaError,
  isClaudeRefusalResult,
  isClaudeTransientUpstreamError,
  isClaudeUnknownSessionError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeImageProcessingError,
  isClaudeModelNotFoundError,
} from "./parse.js";
import {
  materializeRemoteClaudeConfig,
  prepareClaudeConfigSeed,
  resolveManagedClaudeRuntimeStateDir,
  resolveSharedClaudeConfigDir,
  writePaperclipClaudeMcpConfig,
} from "./claude-config.js";
import { claudeCommandSupportsEffortFlag } from "./cli-capabilities.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { buildClaudeExecutionPermissionArgs } from "./permissions.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  createClaudeAcpExecutor,
  formatClaudeAcpFallbackMessage,
  resolveClaudeExecutionEngineForRun,
} from "./acp.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeClaudeAcp = createClaudeAcpExecutor();

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeCommandSpec?: AdapterExecutionContext["runtimeCommandSpec"];
  executionTarget?: ReturnType<typeof readAdapterExecutionTarget>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

interface ClaudeRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

export function claudeSessionCwdMatchesExecutionTarget(input: {
  runtimeSessionCwd: string;
  effectiveExecutionCwd: string;
  executionTargetIsRemote: boolean;
}): boolean {
  if (input.executionTargetIsRemote || input.runtimeSessionCwd.length === 0) return true;
  return path.resolve(input.runtimeSessionCwd) === path.resolve(input.effectiveExecutionCwd);
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, runtimeCommandSpec, executionTarget, authToken } = input;
  const onLog = input.onLog ?? (async () => {});

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
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
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    workspaceHints,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
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
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
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
  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    env[key] = value;
  }

  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: runtimeCommandSpec?.installCommand,
    detectCommand: runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runAdapterExecutionTargetProcess(input.runId, null, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const engineSelection = await resolveClaudeExecutionEngineForRun(ctx);
  if (engineSelection.engine === "acp") {
    try {
      return await executeClaudeAcp(ctx);
    } catch (err) {
      if (engineSelection.explicit) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stderr",
        formatClaudeAcpFallbackMessage(`Claude ACP startup failed: ${reason}`),
      );
    }
  }
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    await ctx.onLog("stderr", formatClaudeAcpFallbackMessage(engineSelection.fallbackReason));
  }

  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const executionTargetIsSandbox = executionTarget?.kind === "remote" && executionTarget.transport === "sandbox";

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const configEnv = parseObject(config.env);
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const hasExplicitClaudeConfigDir =
    typeof configEnv.CLAUDE_CONFIG_DIR === "string" && configEnv.CLAUDE_CONFIG_DIR.trim().length > 0;
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    runtimeCommandSpec: ctx.runtimeCommandSpec,
    executionTarget,
    authToken,
    onLog,
  });
  const {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv: initialLoggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  let loggedEnv = initialLoggedEnv;
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const terminalResultCleanupGraceMs = Math.max(
    0,
    asNumber(config.terminalResultCleanupGraceMs, 5_000),
  );
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const claudeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveClaudeDesiredSkillNames(config, claudeSkillEntries));
  // When instructionsFilePath is configured, build a stable content-addressed
  // file that includes both the file content and the path directive, so we only
  // need --append-system-prompt-file (Claude CLI forbids using both flags together).
  let combinedInstructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      combinedInstructionsContents = instructionsContent + pathDirective;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  // Tell the model what the company library actually holds. Without this, an
  // installed-but-not-enabled skill is indistinguishable from a nonexistent
  // one from inside the sandbox, and agents tell users freshly installed
  // skills "are not installed". Deterministic text appended to the
  // instructions, so it participates in the prompt-bundle cache key and only
  // busts the cache when the library really changes.
  const skillLibraryManifest = buildSkillLibraryManifestMarkdown({
    entries: claudeSkillEntries,
    desiredSkillKeys: desiredSkillNames,
  });
  if (skillLibraryManifest) {
    combinedInstructionsContents = combinedInstructionsContents
      ? `${combinedInstructionsContents}\n\n${skillLibraryManifest}`
      : skillLibraryManifest;
  }
  // Missing-source entries must never reach the bundle: their path does not
  // exist, so the bundle hasher would throw and fail the whole run over one
  // broken skill. Log each one instead so the cause lands in the run output.
  const desiredSkillEntries = claudeSkillEntries.filter((entry) => desiredSkillNames.has(entry.key));
  const mountableSkillEntries = desiredSkillEntries.filter((entry) => !isPaperclipSkillSourceMissing(entry));
  for (const entry of desiredSkillEntries) {
    if (!isPaperclipSkillSourceMissing(entry)) continue;
    await onLog(
      "stderr",
      `[paperclip] Warning: skill "${entry.key}" is enabled for this agent but its files are unavailable and it was not mounted${entry.missingDetail ? `: ${entry.missingDetail}` : "."}\n`,
    );
  }
  const promptBundle = await prepareClaudePromptBundle({
    companyId: agent.companyId,
    skills: mountableSkillEntries,
    instructionsContents: combinedInstructionsContents,
    onLog,
  });
  const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
  const runtimeMcpIdentity = JSON.stringify(
    runtimeMcpServers.map(({ name, url, connectionId }) => ({ name, url, connectionId })),
  );
  const claudeRuntimeStateDir = resolveManagedClaudeRuntimeStateDir(
    process.env,
    agent.companyId,
    agent.id,
  );
  const localMcpConfigPath = await writePaperclipClaudeMcpConfig({
    stateDir: claudeRuntimeStateDir,
    runId,
    servers: runtimeMcpServers,
  });
  const localMcpConfigDir = path.dirname(localMcpConfigPath);
  const sharedClaudeConfigDir = resolveSharedClaudeConfigDir(process.env);
  const networkScope = parseLocalProcessNetworkScope(config.networkScope);
  const filesystemScope = parseLocalProcessFilesystemScope(config.filesystemScope);
  const localProcessSandbox: LocalProcessSandboxOptions | null =
    (filesystemScope || networkScope) && !executionTargetIsRemote
      ? {
          workspaceDir: effectiveExecutionCwd,
          filesystemScope,
          managedPaths: [
            { path: sharedClaudeConfigDir, access: "rw" },
            { path: path.join(path.dirname(sharedClaudeConfigDir), ".claude.json"), access: "rw" },
            { path: promptBundle.addDir, access: "ro" },
            { path: localMcpConfigDir, access: "ro" },
          ],
          extraPaths: parseLocalProcessSandboxExtraPaths(config.filesystemExtraPaths),
          homeDir: filesystemScope ? path.dirname(sharedClaudeConfigDir) : null,
          networkScope,
          networkAllowlist: parseLocalProcessNetworkAllowlist(config.networkAllowlist),
          networkTrustedUrls: [
            env.PAPERCLIP_API_URL,
            ...runtimeMcpServers.map((server) => server.url),
          ].filter((value): value is string => typeof value === "string" && value.length > 0),
          command: asString(config.filesystemSandboxCommand, "bwrap"),
        }
      : null;
  if (localProcessSandbox) {
    if (filesystemScope) env.CLAUDE_CONFIG_DIR = sharedClaudeConfigDir;
    const scopes = [filesystemScope ? "workspace filesystem" : null, networkScope ? `${networkScope} network` : null]
      .filter(Boolean)
      .join(" and ");
    await onLog(
      "stdout",
      `[paperclip] Confining Claude with ${scopes} scope.\n`,
    );
  }
  const useManagedRemoteClaudeConfig =
    executionTargetIsRemote &&
    adapterExecutionTargetUsesManagedHome(executionTarget) &&
    !hasExplicitClaudeConfigDir;
  const claudeConfigSeedDir = useManagedRemoteClaudeConfig
    ? await prepareClaudeConfigSeed(process.env, onLog, agent.companyId)
    : null;
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Claude runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "claude",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: promptBundle.addDir,
              followSymlinks: true,
            },
            {
              key: "mcp-config",
              localDir: localMcpConfigDir,
              followSymlinks: true,
            },
            ...(claudeConfigSeedDir
              ? [{
                key: "config-seed",
                localDir: claudeConfigSeedDir,
                followSymlinks: true,
              }]
              : []),
          ],
        });
      })()
    : null;
  if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig: configEnv,
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
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line))
    : null;
  const effectivePromptBundleAddDir = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.skills ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude", "skills")
    : promptBundle.addDir;
  const effectiveInstructionsFilePath = promptBundle.instructionsFilePath
    ? executionTargetIsRemote
      ? path.posix.join(effectivePromptBundleAddDir, path.basename(promptBundle.instructionsFilePath))
      : promptBundle.instructionsFilePath
    : undefined;
  const effectiveMcpConfigPath = executionTargetIsRemote
    ? path.posix.join(
        preparedExecutionTargetRuntime?.assetDirs["mcp-config"] ??
          path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude", "mcp-config"),
        path.basename(localMcpConfigPath),
      )
    : localMcpConfigPath;
  const remoteClaudeRuntimeRoot = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.runtimeRootDir ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude")
    : null;
  const remoteClaudeConfigSeedDir = claudeConfigSeedDir && remoteClaudeRuntimeRoot
    ? preparedExecutionTargetRuntime?.assetDirs["config-seed"] ??
      path.posix.join(remoteClaudeRuntimeRoot, "config-seed")
    : null;
  const remoteClaudeConfigDir = useManagedRemoteClaudeConfig && remoteClaudeRuntimeRoot
    ? path.posix.join(remoteClaudeRuntimeRoot, "config")
    : null;
  if (remoteClaudeConfigDir && remoteClaudeConfigSeedDir) {
    env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
    loggedEnv.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
    await onLog(
      "stdout",
      `[paperclip] Materializing Claude auth/config into ${remoteClaudeConfigDir}.\n`,
    );
    await materializeRemoteClaudeConfig({
      runId,
      target: executionTarget,
      remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir,
      options: {
        cwd,
        env,
        timeoutSec: Math.max(timeoutSec, 15),
        graceSec,
        onLog,
      },
    });
  }
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
      duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "claude",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
      const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
      loggedEnv = buildInvocationEnvForLogs(env, {
        runtimeEnv,
        includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
        resolvedCommand,
      });
      if (remoteClaudeConfigDir) {
        loggedEnv.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      }
    }
  }
  let effectiveEffort = effort;
  if (executionTargetIsSandbox && effort) {
    const supportsEffort = await claudeCommandSupportsEffortFlag({
      runId,
      command,
      target: runtimeExecutionTarget,
      cwd,
      env,
      timeoutSec,
      graceSec,
    });
    if (supportsEffort === false) {
      effectiveEffort = "";
      await onLog(
        "stderr",
        `[paperclip] Claude CLI in the environment does not advertise --effort; omitting configured effort "${effort}". Upgrade the environment CLI/image to restore reasoning-effort control.\n`,
      );
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const runtimeMcpServerIdentity = asString(runtimeSessionParams.mcpServerIdentity, "");
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const hasMatchingMcpServers =
    runtimeMcpServerIdentity.length === 0
      ? runtimeMcpServers.length === 0
      : runtimeMcpServerIdentity === runtimeMcpIdentity;
  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runtimeSessionId);
  // The cwd the recorded session actually belongs to. Sessions saved before the
  // adapter recorded a cwd carry an empty string; fall back to the execution cwd
  // so the legacy shape keeps behaving as it did.
  const recordedSessionCwd = runtimeSessionCwd || effectiveExecutionCwd;
  // The CLI encodes the child's own `process.cwd()`, which the OS has already
  // resolved through any symlink on the way in — a macOS `/var/folders/...`
  // workspace is filed under `-private-var-folders-...`, and the same is true
  // of a symlinked worktree root or a `/tmp` that points elsewhere. Resolving
  // the recorded cwd the same way is what keeps the probe looking in the
  // directory that actually exists. A cwd that no longer resolves falls back to
  // the raw string; the probe then misses, which is the right answer anyway.
  //
  // Only an errno that actually means "not there" may be read as absence.
  // PAPERCLIP_HOME is a gcsfuse mount, where a stat can answer EIO or stall
  // while the transcript is perfectly intact; treating that as absence
  // discards a live 40-turn session and mints a fresh one. ENOTDIR is included
  // because a missing parent directory surfaces that way rather than as ENOENT.
  const isAbsentErrno = (err: unknown) => {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  };
  const describeProbeErrno = (err: unknown) =>
    (err as NodeJS.ErrnoException | null)?.code ?? (err instanceof Error ? err.message : String(err));
  // Set when the filesystem declined to answer rather than answering "absent".
  // An inconclusive probe must not discard anything: the resume proceeds and
  // the CLI's own unknown-session error stays the backstop, which costs one
  // attempt instead of a conversation.
  let transcriptProbeInconclusive: string | null = null;
  let transcriptProbeCwd = recordedSessionCwd;
  try {
    transcriptProbeCwd = await fs.realpath(recordedSessionCwd);
  } catch (err) {
    // A cwd that is simply gone leaves the raw string as the slug to probe,
    // which is the pre-existing behaviour and the right one. Any other errno
    // means the filesystem did not answer, so the slug may be the wrong one
    // and the probe below cannot be trusted to mean anything.
    if (!isAbsentErrno(err)) {
      transcriptProbeInconclusive = `recorded cwd "${recordedSessionCwd}" did not resolve (${describeProbeErrno(err)})`;
    }
  }
  // Transcript-existence gate. The Claude CLI answers `--resume <id>` from an
  // on-disk JSONL under its projects directory; when that file is gone (the
  // worktree was rebuilt, the config dir was cleared, or the session was only
  // ever a server-side record), passing --resume burns a whole attempt on an
  // unknown-session error before the retry starts fresh. Probe first and start
  // fresh directly, recording why. Local execution only: a recorded remote cwd
  // stat'd against the host filesystem means nothing.
  let transcriptMissingReason: string | null = null;
  if (!executionTargetIsRemote && runtimeSessionId.length > 0 && isValidUuid && !transcriptProbeInconclusive) {
    const transcriptProbePath = buildClaudeTranscriptProbePath({
      claudeConfigDir: resolveSharedClaudeConfigDir(effectiveEnv),
      recordedCwd: transcriptProbeCwd,
      sessionId: runtimeSessionId,
    });
    try {
      await fs.stat(transcriptProbePath);
    } catch (err) {
      if (isAbsentErrno(err)) {
        transcriptMissingReason = `Claude session transcript "${transcriptProbePath}" does not exist`;
      } else {
        transcriptProbeInconclusive = `probing "${transcriptProbePath}" failed (${describeProbeErrno(err)})`;
      }
    }
  }
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    isValidUuid &&
    hasMatchingPromptBundle &&
    hasMatchingMcpServers &&
    transcriptMissingReason === null &&
    claudeSessionCwdMatchesExecutionTarget({
      runtimeSessionCwd,
      effectiveExecutionCwd,
      executionTargetIsRemote,
    }) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (transcriptMissingReason) {
    await onLog(
      "stdout",
      `[paperclip] ${transcriptMissingReason}; starting a fresh session.\n`,
    );
  }
  if (transcriptProbeInconclusive) {
    await onLog(
      "stdout",
      `[paperclip] Claude session transcript probe was inconclusive: ${transcriptProbeInconclusive}; resuming anyway.\n`,
    );
  }
  if (runtimeSessionId && !isValidUuid) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" is not a valid UUID and will not be passed to --resume.\n`,
    );
  }
  if (
    executionTargetIsRemote &&
    runtimeSessionId &&
    isValidUuid &&
    !canResumeSession
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (
    runtimeSessionId &&
    isValidUuid &&
    runtimeSessionCwd.length > 0 &&
    path.resolve(runtimeSessionCwd) !== path.resolve(effectiveExecutionCwd)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && isValidUuid && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
    );
  }
  if (runtimeSessionId && !hasMatchingMcpServers) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved with a different runtime MCP server set and will not be resumed.\n`,
    );
  }
  // Why the recorded session is not being resumed, in the same words the logs
  // above already use. This is the `reason` on the `session.recovery` event, so
  // a lost conversation names its cause instead of looking like a first run.
  const freshSessionReason = canResumeSession
    ? null
    : !runtimeSessionId
    ? "No Claude session was recorded for this task"
    : !isValidUuid
    ? `Recorded Claude session "${runtimeSessionId}" is not a valid UUID`
    : transcriptMissingReason
    ? transcriptMissingReason
    : !hasMatchingPromptBundle
    ? `Recorded Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}", not "${promptBundle.bundleKey}"`
    : !hasMatchingMcpServers
    ? `Recorded Claude session "${runtimeSessionId}" was saved with a different runtime MCP server set`
    : `Recorded Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" or a different execution target, not "${effectiveExecutionCwd}"`;
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
  const taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession: Boolean(sessionId) });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(sessionId),
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: taskContextNote.length > 0,
  });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    taskContextChars: taskContextNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Claude is the one harness where the caller can name the session up front:
  // `claude --session-id <uuid>` (verified against the installed CLI, which
  // documents it as "Use a specific session ID for the..."). Minting it here
  // means the run's session id exists before the child does, so a run killed
  // after spawn but before the first structured event still has something to
  // resume. Minted once per execute(): the retry below only fires when the
  // first attempt passed --resume, so at most one fresh attempt ever runs.
  const mintedFreshSessionId = randomUUID();

  // Everything but the session id is known before the spawn, so the provisional
  // checkpoint and the final AdapterExecutionResult can share one shape rather
  // than drifting apart. Keeps `cwd` (not effectiveExecutionCwd) because that is
  // what the resume gate above reads back out of runtimeSessionParams.
  const buildSessionParams = (sessionIdForParams: string): Record<string, unknown> => ({
    sessionId: sessionIdForParams,
    cwd,
    promptBundleKey: promptBundle.bundleKey,
    mcpServerIdentity: runtimeMcpIdentity,
    ...(executionTargetIsRemote
      ? {
          remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
        }
      : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
    ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
  });

  // The awaited form, used from onSpawn. That call site runs once per attempt
  // and is not the stdout hot path, so it can afford to wait — and it has to:
  // the checkpoint must land BEFORE onSpawn records the pid, or a run can have
  // a pid and no checkpoint, which is the exact window minting exists to close.
  // A rejecting sink still must not fail the run; the checkpoint is provisional.
  const persistSessionCheckpoint = async (payload: SessionCheckpointPayload) => {
    if (!onEvent) return;
    await onEvent({
      eventType: SESSION_CHECKPOINT_EVENT_TYPE,
      stream: "system",
      payload: { ...payload },
    }).catch(() => {
      // The checkpoint is provisional; losing one costs a resume, not the run.
    });
  };

  // Fire-and-forget by design, and only from the stdout path: awaiting there
  // would apply backpressure to the child, because the process runner pauses
  // the readable and serializes every onLog call through its logChain before
  // resuming.
  const emitSessionCheckpoint = (payload: SessionCheckpointPayload) => {
    void persistSessionCheckpoint(payload);
  };

  // Recovery events are emitted once per run, off the stdout hot path, so they
  // are awaited normally.
  const emitSessionRecovery = async (payload: SessionRecoveryPayload) => {
    if (!onEvent) return;
    await onEvent({
      eventType: SESSION_RECOVERY_EVENT_TYPE,
      stream: "system",
      payload: { ...payload },
    });
  };

  const buildClaudeArgs = (
    resumeSessionId: string | null,
    attemptInstructionsFilePath: string | undefined,
  ) => {
    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    // --session-id and --resume are mutually exclusive: resuming already names
    // the session, and passing both asks the CLI to adopt two identities.
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    else args.push("--session-id", mintedFreshSessionId);
    args.push(...buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions,
      targetIsRemote: executionTargetIsRemote,
      localProcessUid: process.getuid?.() ?? null,
    }));
    if (chrome) args.push("--chrome");
    // For Bedrock: only pass --model when the ID is a Bedrock-native identifier
    // (e.g. "us.anthropic.*" or ARN). Anthropic-style IDs like "claude-opus-4-6" are invalid
    // on Bedrock, so skip them and let the CLI use its own configured model.
    if (model && (!isBedrockAuth(effectiveEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effectiveEffort) args.push("--effort", effectiveEffort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session cache;
    // re-injecting them via --append-system-prompt-file wastes 5-10K tokens
    // per heartbeat and the Claude CLI may reject the combination outright.
    if (attemptInstructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", attemptInstructionsFilePath);
    }
    if (runtimeMcpServers.length > 0) {
      args.push("--mcp-config", effectiveMcpConfigPath, "--strict-mcp-config");
    }
    args.push("--add-dir", effectivePromptBundleAddDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (
    resumeSessionId: string | null,
    attempt: number,
    freshReason: string | null,
  ) => {
    // The session this attempt runs under, known before the spawn on both
    // paths: the resumed id, or the id we minted for it.
    const attemptSessionId = resumeSessionId ?? mintedFreshSessionId;
    // Scoped to the attempt, never outside it. The retry below runs attempt 1
    // with `--resume X` and attempt 2 with the freshly minted Y; a latch that
    // outlived the attempt boundary would still be holding X and would
    // checkpoint it over Y, pointing the next run at the wrong session.
    const latch = createStreamSessionIdLatch({
      parse: parseClaudeStreamJson,
      onSessionId: (streamSessionId) => {
        // The pre-spawn checkpoint below already carries `attemptSessionId`, so
        // the stream is a divergence check, not the primary path: re-checkpoint
        // only if the CLI named a session other than the one it was handed.
        if (streamSessionId === attemptSessionId) return;
        emitSessionCheckpoint({
          attempt,
          sessionId: streamSessionId,
          sessionParams: buildSessionParams(streamSessionId),
          source: "stream",
        });
      },
    });
    if (!resumeSessionId) {
      await emitSessionRecovery({
        outcome: runtimeSessionId ? "fresh_missing" : "fresh_none",
        sessionId: runtimeSessionId || null,
        reason: freshReason ?? "No Claude session was recorded for this task",
      });
    }
    const attemptInstructionsFilePath = resumeSessionId ? undefined : effectiveInstructionsFilePath;
    const args = buildClaudeArgs(resumeSessionId, attemptInstructionsFilePath);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Claude prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (dangerouslySkipPermissions && executionTargetIsRemote) {
      commandNotes.push(
        "Using a broad --allowedTools whitelist for remote execution so hosted targets do not inherit local Claude bypass permissions.",
      );
    }
    if (attemptInstructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      );
    }
    if (runtimeMcpServers.length > 0) {
      commandNotes.push(
        `Using ${runtimeMcpServers.length} Paperclip-managed MCP server(s) from strict config ${effectiveMcpConfigPath}.`,
      );
    }
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn: async (meta) => {
        // Checkpoint the moment the child has a pid, rather than waiting for
        // stdout: a run killed between spawn and the first structured event is
        // exactly the case minting exists to cover. Awaited, and ordered ahead
        // of the onSpawn that records the pid, so "this run has a pid" implies
        // "this run has a checkpoint" rather than merely making it likely.
        await persistSessionCheckpoint({
          attempt,
          sessionId: attemptSessionId,
          sessionParams: buildSessionParams(attemptSessionId),
          // Caller-supplied: we handed this id to the CLI (as --session-id or
          // as --resume) and it has not confirmed it yet, so an id that never
          // grows a transcript is outcome 1, not a lost conversation.
          source: "minted",
        });
        if (onSpawn) await onSpawn(meta);
      },
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") latch.push(chunk);
        await onLog(stream, chunk);
      },
      runLogTail: paperclipBridge?.runLogTail,
      settleRunDisposition: paperclipBridge?.settleRunDisposition,
      terminalResultCleanup: {
        graceMs: terminalResultCleanupGraceMs,
        hasTerminalResult: ({ stdout }) => parseClaudeStreamJson(stdout).resultJson !== null,
      },
      localProcessSandbox,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    // What the attempt actually ran under, carried out to finalization. The
    // latch saw the stream from its first byte; `proc.stdout` is only the last
    // MAX_CAPTURE_BYTES of it, so on a long run the latch is the one that still
    // knows the id. `attemptSessionId` backstops both: Claude was handed it.
    return {
      proc,
      parsedStream,
      parsed,
      attemptSessionId,
      streamSessionId: latch.sessionId,
    };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
      attemptSessionId: string;
      streamSessionId: string | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      // Name the session the attempt ran under. A result that names neither a
      // sessionId nor sessionParams is not neutral: resolveNextSessionState
      // falls back to the pre-dispatch snapshot and writes it over the
      // checkpoint this run persisted at spawn, so a timeout — the common case
      // this whole mechanism exists for — would delete its own session and the
      // retry would start cold.
      const timedOutSessionId = attempt.streamSessionId ?? attempt.attemptSessionId;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        sessionId: timedOutSessionId,
        sessionParams: buildSessionParams(timedOutSessionId),
        sessionDisplayId: timedOutSessionId,
        clearSession: Boolean(opts.clearSessionOnMissingSession && !timedOutSessionId),
      };
    }

    if (!parsed) {
      const fallbackErrorMessage = parseFallbackErrorMessage(proc);
      const providerQuota =
        !loginMeta.requiresLogin &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeProviderQuotaError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientUpstream =
        !loginMeta.requiresLogin &&
        !providerQuota &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeTransientUpstreamError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientRetryNotBefore = providerQuota || transientUpstream
        ? extractClaudeRetryNotBefore({
            parsed: null,
            stdout: proc.stdout,
            stderr: proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
      const errorCode = proc.errorCode
        // Forward the transport-level error code from the run-disposition seam
        // first, even on the unparsed path. A lost duplex control channel
        // surfaces the typed `duplex_channel_lost` code before any provider
        // classification, so the CLI lane and the ACP lane report it alike.
        ? proc.errorCode
        : loginMeta.requiresLogin
        ? "claude_auth_required"
        : isClaudeModelNotFoundError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        })
        ? "model_not_found"
        : providerQuota
        ? "provider_quota"
        : transientUpstream
        ? "claude_transient_upstream"
        : null;
      const errorFamily = providerQuota ? "provider_quota" : transientUpstream ? "transient_upstream" : null;
      // Same deletion as the timeout branch above: naming nothing here lets the
      // pre-dispatch snapshot overwrite the spawn checkpoint, so a child that
      // died on a transient upstream error after thirty turns loses the
      // conversation it left on disk. Only a STREAM-confirmed id is named:
      // there is no result JSON to prove the CLI ever accepted the minted one,
      // and persisting an unconfirmed id would make the next run's failed probe
      // look like outcome 3 (a session was lost) when it is outcome 1 (none was
      // ever created). No confirmed id means the existing behaviour stands.
      const unparsedSessionId = parsedStream.sessionId ?? attempt.streamSessionId;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: fallbackErrorMessage,
        errorCode,
        errorFamily,
        retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
        errorMeta,
        ...(unparsedSessionId
          ? {
              sessionId: unparsedSessionId,
              sessionParams: buildSessionParams(unparsedSessionId),
              sessionDisplayId: unparsedSessionId,
            }
          : {}),
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          ...(errorFamily ? { errorFamily } : {}),
          ...(transientRetryNotBefore
            ? { retryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(transientRetryNotBefore
            ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(providerQuota && transientRetryNotBefore
            ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession && !unparsedSessionId),
      };
    }

    const fallbackModelUsageTotals = parsedStream.usage ? null : claudeModelUsageTotals(parsed.modelUsage);
    const usage =
      parsedStream.usage ??
      fallbackModelUsageTotals ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();
    const usageBasis = parsedStream.usage
      ? parsedStream.usageBasis
      : fallbackModelUsageTotals
      ? ("per_run" as const)
      : null;

    const rawResolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    const poisonedPreviousMessageId = isClaudePoisonedPreviousMessageIdError(parsed);
    // Fable 5 policy refusals exit cleanly (exitCode=0, is_error=false), so this
    // is intentionally independent of `failed` — otherwise a refusal looks like a
    // successful run to Paperclip and the heartbeat stalls silently. See RY-604.
    const claudeRefusal = isClaudeRefusalResult(parsed);
    const parsedIsError = asBoolean(parsed.is_error, false);
    const parsedSubtype = asString(parsed.subtype, "").trim().toLowerCase();
    const parsedSucceeded = parsedSubtype === "success" && !parsedIsError;
    const failed = !parsedSucceeded && ((proc.exitCode ?? 0) !== 0 || parsedIsError);
    // Validate-before-persist guard: never persist a sessionId whose transcript
    // is known-poisoned. The Claude CLI keeps an on-disk JSONL keyed by the
    // session id; if the last entry contains a non-`msg_`-prefixed
    // `previous_message_id`, every subsequent `--resume` hits a 400 from
    // /v1/messages and the issue is permanently unrecoverable until the
    // sessionId is dropped server-side. Drop here so resolveNextSessionState
    // calls clearTaskSessions on the next heartbeat. See RED-978 / RED-976.
    //
    // This guard is also why the session.checkpoint event is only ever
    // PROVISIONAL. The checkpoint fires at spawn, before anything is known
    // about the transcript; this guard runs after the child exits and may
    // reject the very id that was checkpointed. The final result below must
    // therefore keep carrying a null `sessionId` plus `clearSession`, so the
    // host clears the checkpoint it already persisted rather than leaving a
    // known-poisoned id behind for the next run to resume.
    const shouldDropSessionForPoison = poisonedPreviousMessageId;
    const resolvedSessionId = shouldDropSessionForPoison ? null : rawResolvedSessionId;
    const resolvedSessionParams = resolvedSessionId ? buildSessionParams(resolvedSessionId) : null;
    const errorMessage = failed
      ? describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`
      : null;
    const providerQuota =
      failed &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      !poisonedPreviousMessageId &&
      isClaudeProviderQuotaError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientUpstream =
      failed &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      !poisonedPreviousMessageId &&
      !providerQuota &&
      isClaudeTransientUpstreamError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientRetryNotBefore = providerQuota || transientUpstream
      ? extractClaudeRetryNotBefore({
          parsed,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage,
        })
      : null;
    const resolvedErrorCode = proc.errorCode
      // Forward the transport-level error code from the run-disposition seam
      // first. A lost duplex control channel surfaces the typed
      // `duplex_channel_lost` code before any provider classification.
      ? proc.errorCode
      : loginMeta.requiresLogin
      ? "claude_auth_required"
      : failed && isClaudeModelNotFoundError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      })
      ? "model_not_found"
      : failed && clearSessionForMaxTurns
      ? "max_turns_exhausted"
      : failed && poisonedPreviousMessageId
      ? "claude_poisoned_previous_message_id"
      : providerQuota
      ? "provider_quota"
      : transientUpstream
      ? "claude_transient_upstream"
      : claudeRefusal
      ? "claude_refusal"
      : null;
    const errorFamily = providerQuota
      ? "provider_quota"
      : transientUpstream
      ? "transient_upstream"
      : claudeRefusal
      ? "model_refusal"
      : null;
    const mergedResultJson: Record<string, unknown> = {
      ...parsed,
      ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
      ...(failed && poisonedPreviousMessageId ? { stopReason: "claude_poisoned_previous_message_id" } : {}),
      ...(claudeRefusal ? { stopReason: "refusal", errorFamily: "model_refusal" } : {}),
      ...(errorFamily ? { errorFamily } : {}),
      ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(providerQuota && transientRetryNotBefore ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
    };

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: resolvedErrorCode,
      errorFamily,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      errorMeta,
      usage,
      ...(usageBasis ? { usageBasis } : {}),
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd,
      resultJson: mergedResultJson,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession:
        clearSessionForMaxTurns ||
        // Clear-on-error: a poisoned previous_message_id is a deterministic
        // state error. Force the server to drop persisted session state for
        // this issue so the next continuation starts from a clean slate.
        poisonedPreviousMessageId ||
        Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null, 1, freshSessionReason);
    const sessionErrorKind =
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed
        ? isClaudeUnknownSessionError(initial.parsed)
          ? "unknown"
          : isClaudePoisonedPreviousMessageIdError(initial.parsed)
          ? "poisoned"
          : isClaudeImageProcessingError(initial.parsed)
          ? "image"
          : null
        : null;

    if (sessionErrorKind !== null) {
      const reason =
        sessionErrorKind === "poisoned"
          ? "returned a poisoned message-id"
          : sessionErrorKind === "image"
          ? "contains an unprocessable image"
          : "is unavailable";
      await onLog(
        "stdout",
        `[paperclip] Claude resume session "${sessionId}" ${reason}; retrying with a fresh session.\n`,
      );
      if (sessionErrorKind === "poisoned" && sessionId && !executionTargetIsRemote) {
        // Derive the transcript path from the cwd the session was RECORDED
        // under, not the cwd this run happens to execute in. Deriving it from
        // the current cwd made the unlink a no-op for any session that moved
        // worktrees, so the poisoned transcript survived and every later
        // --resume against it failed the same way.
        const poisonedJsonlPath = buildClaudeTranscriptProbePath({
          claudeConfigDir: resolveSharedClaudeConfigDir(effectiveEnv),
          recordedCwd: transcriptProbeCwd,
          sessionId,
        });
        let unlinked = false;
        try {
          await fs.unlink(poisonedJsonlPath);
          unlinked = true;
        } catch {
          // best-effort; session is cleared server-side regardless
        }
        if (unlinked) {
          try {
            await onLog("stdout", `[paperclip] Removed poisoned session file: ${poisonedJsonlPath}\n`);
          } catch {
            // log stream may be closed; the unlink already succeeded
          }
        }
      }
      // The resume itself failed, so this run's outcome is fresh_missing and
      // attempt 2 emits it — which is why attempt 1 emitted no recovery event
      // when it passed --resume. One recovery event per run, naming the
      // session that was lost and why.
      const retry = await runAttempt(
        null,
        2,
        `Recorded Claude session "${sessionId}" ${reason}`,
      );
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    if (sessionId) {
      // The resume attempt ran and the child did not report the session as
      // unknown, poisoned or unprocessable: outcome 2, the conversation
      // survived. Emitted here rather than at spawn because "resumed" is only
      // knowable once the harness has accepted the id.
      await emitSessionRecovery({
        outcome: "resumed",
        sessionId,
        reason: `Resumed Claude session "${sessionId}" in "${effectiveExecutionCwd}"`,
      });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    if (paperclipBridge) {
      await paperclipBridge.stop();
    }
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
  }
}
