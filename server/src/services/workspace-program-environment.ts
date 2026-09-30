import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, environmentLeases, environments, pipelineCaseWorkTurns } from "@paperclipai/db";
import type { Environment, EnvironmentLease, ExecutionWorkspace } from "@paperclipai/shared";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { conflict, forbidden } from "../errors.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { evaluateExecutionAllowlist, type ExecutionPolicy } from "./execution-allowlist.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import type { readWorkspaceRevisionBinding } from "./workspace-revision-context.js";
import { stageWorkspaceProgramCopy } from "./workspace-program-copy.js";

type Binding = Awaited<ReturnType<typeof readWorkspaceRevisionBinding>>;
type LeaseRow = { lease: EnvironmentLease; environment: Environment | null };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function absoluteDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || /[\0\r\n]/.test(value)
    || path.posix.normalize(value) !== value) {
    throw conflict("The case needs a realized workspace directory", { code: "workspace_environment_unavailable" });
  }
  return value;
}
function executionReceipt(result: { stdout: string; exitCode: number | null; timedOut?: boolean }) {
  return { stdout: result.stdout, exitCode: result.timedOut ? null : result.exitCode };
}

/** An active checkout owns its own lease. Another run's lease, or an orphaned
 * environment, cannot turn a remote workspace into a host-local operation. */
export function selectWorkspaceProgramLease(binding: Binding, rows: LeaseRow[], now = new Date()): LeaseRow | null {
  const candidates = binding.issue.checkoutRunId ? rows.filter((row) => row.lease.heartbeatRunId === binding.issue.checkoutRunId) : rows;
  if (candidates.length > 1) throw conflict("Multiple active workspace environments need reconciliation", { code: "workspace_environment_ambiguous" });
  if (!candidates.length) {
    if (binding.issue.checkoutRunId || rows.length) throw conflict("The checked-out run has no matching workspace lease", { code: "workspace_environment_unavailable" });
    return null;
  }
  const row = candidates[0]!;
  if (!row.environment || row.lease.companyId !== binding.case.companyId || row.lease.executionWorkspaceId !== binding.workspace.id
    || row.lease.issueId !== binding.issue.id || row.lease.environmentId !== row.environment.id || row.lease.status !== "active"
    || row.lease.releasedAt || (row.lease.expiresAt && row.lease.expiresAt <= now)) {
    throw conflict("The workspace lease is missing, expired, or belongs to different work", { code: "workspace_environment_unavailable" });
  }
  return row;
}

export function assertWorkspaceProgramEnvironment(environment: Environment, policy: ExecutionPolicy, companyId: string, boundCompanies: string[], lease?: EnvironmentLease | null) {
  if (environment.status !== "active") throw conflict("The workspace environment is inactive", { code: "workspace_environment_inactive" });
  if (boundCompanies.length && !boundCompanies.includes(companyId)) throw forbidden("The environment belongs to another company", { code: "environment_company_mismatch" });
  const leaseDriver = lease?.metadata?.driver;
  if ((typeof leaseDriver === "string" && leaseDriver !== environment.driver)
    || (lease?.provider && ["local", "ssh"].includes(environment.driver) && lease.provider !== environment.driver)) {
    throw conflict("The environment driver changed since this lease was acquired", { code: "workspace_environment_unavailable" });
  }
  const decision = evaluateExecutionAllowlist(policy, { driver: environment.driver,
    // A mutable environment configuration cannot relabel an existing lease's
    // provider to satisfy the instance execution policy.
    provider: lease ? lease.provider : typeof environment.config?.provider === "string" ? environment.config.provider : null });
  if (!decision.allowed) throw forbidden(decision.reason, { code: "workspace_execution_policy_denied" });
}

function workspaceProgramRealization(binding: Binding, lease: EnvironmentLease) {
  const recorded = object(lease.metadata?.workspaceRealization);
  const record = ["copy", "in_place"].includes(String(recorded.mode)) ? recorded : object(binding.workspace.metadata?.workspaceRealization);
  if (!["copy", "in_place"].includes(String(record.mode))) {
    throw conflict("The workspace needs an authoritative realization", { code: "workspace_environment_unrealized" });
  }
  return record;
}

export function workspaceProgramDirectory(binding: Binding, environment: Environment, lease: EnvironmentLease) {
  const record = workspaceProgramRealization(binding, lease);
  const local = object(record.local);
  if ((record.environmentId && record.environmentId !== environment.id)
    || (record.rebuild && object(record.rebuild).executionWorkspaceId !== binding.workspace.id)
    || (local.branchName && local.branchName !== binding.workspace.branchName)
    || (local.projectId && local.projectId !== binding.workspace.projectId)) {
    throw conflict("The realized workspace does not match this case", { code: "workspace_mismatch" });
  }
  if (record.mode === "in_place") return absoluteDirectory(record.authoritativeRoot);
  const copy = object(lease.metadata?.workspaceProgramCopy);
  if (copy.leaseId === lease.id && copy.workspaceId === binding.workspace.id) return absoluteDirectory(copy.directory);
  const root = absoluteDirectory(lease.metadata?.remoteCwd);
  // The SSH adapter stages a copy under the run directory, not at its connection
  // root. Sandbox adapters use their lease's remoteCwd directly.
  return environment.driver === "ssh" && lease.heartbeatRunId
    ? path.posix.join(root, ".paperclip-runtime", "runs", lease.heartbeatRunId, "workspace") : root;
}

export function workspaceProgramCopyRoot(binding: Binding, lease: EnvironmentLease) {
  const record = workspaceProgramRealization(binding, lease);
  if (record.mode !== "copy") return undefined;
  const cwd = absoluteDirectory(binding.workspace.cwd);
  if (record.authoritativeRoot !== cwd || object(record.local).path !== cwd) {
    throw conflict("The canonical workspace copy changed", { code: "workspace_mismatch" });
  }
  return cwd;
}

export async function readWorkspaceProgramPlacement(db: Db, binding: Binding) {
  const svc = environmentService(db), settings = instanceSettingsService(db);
  const [rows, instance, experimental] = await Promise.all([
    db.select({ lease: environmentLeases, environment: environments }).from(environmentLeases)
      .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
      .where(and(eq(environmentLeases.companyId, binding.case.companyId), eq(environmentLeases.executionWorkspaceId, binding.workspace.id),
        eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt))).limit(101),
    settings.get(), settings.getExperimental(),
  ]);
  if (rows.length > 100) throw conflict("Workspace lease inventory requires reconciliation", { code: "workspace_environment_ambiguous" });
  const policy = { executionMode: instance.general.executionMode, managedSandboxOnly: experimental.enableManagedSandboxOnly === true };
  const active = selectWorkspaceProgramLease(binding, rows as LeaseRow[]);
  let environment = active?.environment ?? null;
  let agent: { id: string; adapterType: string; defaultEnvironmentId: string | null } | null = null;
  if (!environment) {
    const [prior] = await db.select({ id: agents.id, adapterType: agents.adapterType, defaultEnvironmentId: agents.defaultEnvironmentId })
      .from(pipelineCaseWorkTurns).innerJoin(agents, and(eq(agents.id, pipelineCaseWorkTurns.agentId), eq(agents.companyId, binding.case.companyId)))
      .where(and(eq(pipelineCaseWorkTurns.companyId, binding.case.companyId), eq(pipelineCaseWorkTurns.caseId, binding.case.id), isNotNull(pipelineCaseWorkTurns.agentId)))
      .orderBy(desc(pipelineCaseWorkTurns.turn)).limit(1);
    agent = prior ?? null;
    const realization = object(binding.workspace.metadata?.workspaceRealization);
    const recordedId = typeof realization.environmentId === "string" ? realization.environmentId : null;
    const [lastLease] = recordedId ? [] : await db.select({ environmentId: environmentLeases.environmentId }).from(environmentLeases)
      .where(and(eq(environmentLeases.companyId, binding.case.companyId), eq(environmentLeases.executionWorkspaceId, binding.workspace.id)))
      .orderBy(desc(environmentLeases.acquiredAt), desc(environmentLeases.id)).limit(1);
    if (lastLease && !lastLease.environmentId) throw conflict("The last workspace environment was removed", { code: "workspace_environment_unavailable" });
    const selectedId = recordedId ?? lastLease?.environmentId ?? agent?.defaultEnvironmentId ?? instance.defaultEnvironmentId;
    // A persisted remote realization remains remote after its lease ends. Never
    // infer placement from providerType=git_worktree or from a host mirror path.
    environment = selectedId ? await svc.getById(selectedId) : await svc.ensureLocalEnvironment(binding.case.companyId);
    if (!environment) throw conflict("The recorded workspace environment no longer exists", { code: "workspace_environment_unavailable" });
  }
  assertWorkspaceProgramEnvironment(environment, policy, binding.case.companyId, await svc.listBoundCompanyIds(environment.id), active?.lease);
  return { environment, lease: active?.lease ?? null, agent, policy };
}

/** Fixed host programs use the environment's own command transport. SSH is an
 * adapter transport; its runtime driver does not implement execute(). */
export async function workspaceProgramRunner(db: Db, runtime: EnvironmentRuntimeService, binding: Binding,
  environment: Environment, lease: EnvironmentLease, deadline: number): Promise<CommandManagedRuntimeRunner> {
  const timeout = (requested?: number) => {
    const remaining = Math.min(180_000, requested ?? Infinity, deadline - Date.now(), lease.expiresAt ? lease.expiresAt.getTime() - Date.now() - 1000 : Infinity);
    if (remaining < 1000) throw conflict("The workspace execution deadline has expired", { code: "workspace_environment_unavailable" });
    return remaining;
  };
  timeout();
  if (environment.driver === "ssh") {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, binding.case.companyId, environment,
      { issueId: binding.issue.id, heartbeatRunId: lease.heartbeatRunId });
    if (parsed.driver !== "ssh" || ["host", "port", "username"].some((key) => lease.metadata?.[key] !== undefined
      && lease.metadata[key] !== parsed.config[key as "host" | "port" | "username"])) {
      throw conflict("SSH connection changed since workspace realization", { code: "workspace_environment_unavailable" });
    }
    return { execute: async (command) => {
      const cwd = command.cwd ?? "/";
      return runAdapterExecutionTargetProcess(lease.id, { kind: "remote", transport: "ssh", environmentId: environment.id, leaseId: lease.id,
        remoteCwd: cwd, spec: { ...parsed.config, remoteCwd: cwd } }, command.command, command.args ?? [], {
        cwd, stdin: command.stdin, env: command.env ?? {}, timeoutSec: Math.floor(timeout(command.timeoutMs) / 1000), graceSec: 5,
        onLog: command.onLog ?? (async () => {}),
      });
    } };
  }
  return { execute: async (command) => {
    const startedAt = new Date().toISOString();
    const result = await runtime.execute({ environment, lease, command: command.command, args: command.args, cwd: command.cwd,
      stdin: command.stdin, env: command.env, timeoutMs: timeout(command.timeoutMs), bypassSession: true });
    return { stdout: result.stdout, stderr: result.stderr ?? "", exitCode: result.exitCode, timedOut: result.timedOut === true,
      pid: null, signal: null, startedAt };
  } };
}

export async function runRemoteWorkspaceProgram(db: Db, runtime: EnvironmentRuntimeService, binding: Binding,
  environment: Environment, lease: EnvironmentLease, cwd: string, program: string, input: unknown,
  deadline = Date.now() + 180_000, env?: Record<string, string>) {
  const runner = await workspaceProgramRunner(db, runtime, binding, environment, lease, deadline);
  return executionReceipt(await runner.execute({ command: "node", args: ["-e", program], cwd, stdin: JSON.stringify(input), env }));
}

/** Reacquire the case's environment. Copy realizations stage a private pinned
 * snapshot; in-place realizations retain the recorded authoritative directory. */
export async function runUnleasedWorkspaceProgram(db: Db, runtime: EnvironmentRuntimeService, binding: Binding,
  placement: Awaited<ReturnType<typeof readWorkspaceProgramPlacement>>, program: string, input: unknown,
  deadline = Date.now() + 180_000, env?: Record<string, string>) {
  if (deadline - Date.now() < 1000) throw conflict("The workspace execution deadline has expired", { code: "workspace_environment_unavailable" });
  const previous = object(binding.workspace.metadata?.workspaceRealization);
  if (!["in_place", "copy"].includes(String(previous.mode)) || previous.environmentId !== placement.environment.id) {
    throw conflict("The remote workspace needs staging before this operation", { code: "workspace_environment_unrealized" });
  }
  const root = absoluteDirectory(previous.authoritativeRoot), copy = previous.mode === "copy", driver = runtime.getDriver(placement.environment.driver);
  if (copy && (root !== binding.workspace.cwd || object(previous.local).path !== root)) {
    throw conflict("The canonical workspace copy changed", { code: "workspace_mismatch" });
  }
  if (!driver?.realizeWorkspace) throw conflict("The environment cannot realize the case workspace", { code: "workspace_environment_unavailable" });
  const acquired = await runtime.acquireRunLease({ companyId: binding.case.companyId, environment: placement.environment,
    issueId: binding.issue.id, agentId: placement.agent?.id ?? null, adapterType: placement.agent?.adapterType ?? null, heartbeatRunId: null,
    persistedExecutionWorkspace: { id: binding.workspace.id, mode: binding.workspace.mode as ExecutionWorkspace["mode"] },
    executionWorkspaceSettings: binding.issue.executionWorkspaceSettings, assertCompanyBinding: true,
    requestedExpiresAt: new Date(deadline + 5000),
  });
  let lease = acquired.lease;
  let leaseOutcome: "released" | "failed" = copy ? "failed" : "released";
  try {
    const svc = environmentService(db), current = await svc.getById(placement.environment.id);
    if (!current) throw conflict("The environment disappeared during acquisition", { code: "workspace_environment_unavailable" });
    assertWorkspaceProgramEnvironment(current, placement.policy, binding.case.companyId, await svc.listBoundCompanyIds(current.id), lease);
    selectWorkspaceProgramLease(binding, [{ lease, environment: current }]);
    const realized = await runtime.realizeWorkspace({ environment: current, lease, workspace: {
      localPath: binding.workspace.cwd ?? undefined,
      remotePath: copy ? absoluteDirectory(lease.metadata?.remoteCwd ?? object(previous.remote).path) : root, mode: binding.workspace.mode,
      metadata: { workspaceRealizationRequest: binding.workspace.metadata?.workspaceRealizationRequest },
    } });
    const record = object(realized.metadata?.workspaceRealization);
    if (record.mode !== previous.mode || record.authoritativeRoot !== root || (!copy && realized.cwd !== root)
      || (copy && (object(record.local).path !== root || (record.environmentId && record.environmentId !== current.id)
        || (object(record.rebuild).executionWorkspaceId && object(record.rebuild).executionWorkspaceId !== binding.workspace.id)))) {
      throw conflict("Reacquisition did not preserve the authoritative case workspace", { code: "workspace_mismatch" });
    }
    const remoteRoot = copy ? absoluteDirectory(realized.cwd) : root;
    const updated = await svc.updateLeaseMetadata(lease.id, { ...lease.metadata, remoteCwd: remoteRoot, workspaceRealization: record });
    if (!updated) throw conflict("The acquired workspace lease disappeared", { code: "workspace_environment_unavailable" });
    lease = updated;
    if (copy) {
      const runner = await workspaceProgramRunner(db, runtime, binding, current, lease, deadline);
      const directory = path.posix.join(remoteRoot, ".paperclip-runtime", "openspec", lease.id, randomUUID());
      const result = await stageWorkspaceProgramCopy({ cwd: root, request: input, remoteDirectory: directory, leaseId: lease.id,
        provider: lease.provider, deadline, runner,
        ready: async (staged) => {
          const next = await svc.updateLeaseMetadata(lease.id, { ...lease.metadata,
            workspaceProgramCopy: { leaseId: lease.id, workspaceId: binding.workspace.id, directory: staged } });
          if (!next) throw conflict("The acquired workspace lease disappeared", { code: "workspace_environment_unavailable" });
          lease = next;
        },
        execute: async (cwd) => executionReceipt(await runner.execute({ command: "node", args: ["-e", program], cwd, stdin: JSON.stringify(input), env })),
      });
      // An acknowledged terminal command no longer owns these private files.
      // On uncertain completion, leave them to lease/provider cleanup instead.
      if (result.exitCode !== null) {
        const cleanup = await runner.execute({ command: "node", args: ["-e",
          "require('node:fs').rmSync(JSON.parse(require('node:fs').readFileSync(0,'utf8')),{recursive:true,force:true})"],
          cwd: "/", stdin: JSON.stringify(directory) });
        if (cleanup.exitCode !== 0 || cleanup.timedOut) throw conflict("Copied workspace cleanup failed", { code: "workspace_copy_cleanup_failed", leaseId: lease.id });
      }
      if (result.exitCode === 0) leaseOutcome = "released";
      return result;
    }
    return await runRemoteWorkspaceProgram(db, runtime, binding, current, lease, workspaceProgramDirectory(binding, current, lease), program, input, deadline, env);
  } finally {
    // Only this ad-hoc lease is ours to release. Never release an agent's active
    // lease or every lease for its heartbeat run.
    try {
      const released = await driver.releaseRunLease({ environment: placement.environment, lease, status: leaseOutcome });
      if (!released) throw new Error("Lease release was not acknowledged");
    }
    catch { throw conflict("The case environment lease needs cleanup; resume this operation after reconciliation", {
      code: "workspace_environment_release_failed", leaseId: lease.id }); }
  }
}
