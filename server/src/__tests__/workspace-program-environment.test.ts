import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeWorkspaceRevisionProgram, runLocalWorkspaceProgram, type readWorkspaceRevisionBinding } from "../services/workspace-revision-context.js";
import { assertWorkspaceProgramEnvironment, readWorkspaceProgramPlacement, runRemoteWorkspaceProgram,
  runUnleasedWorkspaceProgram, selectWorkspaceProgramLease, workspaceProgramDirectory } from "../services/workspace-program-environment.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

const mocks = vi.hoisted(() => ({ getById: vi.fn(), ensureLocalEnvironment: vi.fn(), listBoundCompanyIds: vi.fn(), updateLeaseMetadata: vi.fn(),
  get: vi.fn(), getExperimental: vi.fn(), driverConfig: vi.fn(), ssh: vi.fn(), copy: vi.fn() }));
vi.mock("../services/environments.js", () => ({ environmentService: () => mocks }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => mocks }));
vi.mock("../services/environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: mocks.driverConfig }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetProcess: mocks.ssh }));
vi.mock("../services/workspace-program-copy.js", () => ({ stageWorkspaceProgramCopy: mocks.copy }));
type Binding = Awaited<ReturnType<typeof readWorkspaceRevisionBinding>>;
function fixture(driver: Environment["driver"] = "sandbox") {
  const environment = { id: randomUUID(), name: "Case environment", driver, status: "active", config: { provider: "kubernetes" } } as Environment;
  const companyId = randomUUID(), workspaceId = randomUUID(), issueId = randomUUID();
  const record = { mode: "in_place", authoritativeRoot: "/persistent/spec-case", environmentId: environment.id,
    rebuild: { executionWorkspaceId: workspaceId }, local: { projectId: "project", branchName: "openspec/change" } };
  const binding = { case: { id: randomUUID(), companyId }, work: { agentId: null },
    issue: { id: issueId, checkoutRunId: null, executionWorkspaceSettings: null },
    workspace: { id: workspaceId, mode: "isolated_workspace", projectId: "project", providerType: "git_worktree", cwd: "/host/mirror",
      branchName: "openspec/change", metadata: { workspaceRealization: record } } } as unknown as Binding;
  const lease = { id: randomUUID(), companyId, environmentId: environment.id, executionWorkspaceId: workspaceId, issueId,
    heartbeatRunId: null, status: "active", releasedAt: null, expiresAt: null, provider: driver === "sandbox" ? "kubernetes" : driver,
    metadata: { driver, remoteCwd: "/connection-root", workspaceRealization: record } } as EnvironmentLease;
  const release = vi.fn(async () => lease), execute = vi.fn(async (_command: unknown) => ({ exitCode: 0, stdout: '{"ok":true}' }));
  const runtime = { getDriver: vi.fn(() => ({ releaseRunLease: release, realizeWorkspace: vi.fn() })),
    acquireRunLease: vi.fn(async () => ({ environment, lease })), realizeWorkspace: vi.fn(async () => ({ cwd: record.authoritativeRoot,
      metadata: { workspaceRealization: record } })), execute } as unknown as EnvironmentRuntimeService;
  mocks.getById.mockResolvedValue(environment); mocks.updateLeaseMetadata.mockImplementation(async (_id, metadata) => ({ ...lease, metadata }));
  const placement = { environment, lease: null, agent: { id: randomUUID(), adapterType: "opencode_local", defaultEnvironmentId: environment.id }, policy: {} };
  return { environment, binding, lease, record, runtime, release, execute, placement };
}
function database(...results: unknown[][]) {
  return { select: vi.fn(() => {
    const rows = results.shift() ?? [];
    const chain = { from: () => chain, leftJoin: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain,
      limit: async () => rows };
    return chain;
  }) } as unknown as Db;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.listBoundCompanyIds.mockResolvedValue([]);
  mocks.get.mockResolvedValue({ general: { executionMode: "any" }, defaultEnvironmentId: null }); mocks.getExperimental.mockResolvedValue({});
  mocks.ensureLocalEnvironment.mockResolvedValue({ id: "local", driver: "local", status: "active", config: {} });
  mocks.copy.mockImplementation(async (input) => {
    await input.ready(input.remoteDirectory);
    return { ...await input.execute(input.remoteDirectory), copyRestoreCwd: input.cwd };
  });
});

describe("case workspace environment ownership and placement", () => {
  it("selects the active checkout's own lease without borrowing another run", () => {
    const f = fixture(); f.binding.issue.checkoutRunId = "current-run"; f.lease.heartbeatRunId = "current-run";
    const row = { lease: f.lease, environment: f.environment };
    expect(selectWorkspaceProgramLease(f.binding, [{ ...row, lease: { ...f.lease, heartbeatRunId: "other" } }, row])).toBe(row);
    expect(() => selectWorkspaceProgramLease(f.binding, [{ ...row, lease: { ...f.lease, heartbeatRunId: "other" } }]))
      .toThrowError(expect.objectContaining({ details: { code: "workspace_environment_unavailable" } }));
  });
  it.each(["company", "workspace", "issue", "expired", "orphan", "released"])("refuses a %s lease before command execution", (kind) => {
    const f = fixture(), row = { lease: f.lease, environment: f.environment as Environment | null };
    if (kind === "company") f.lease.companyId = randomUUID();
    if (kind === "workspace") f.lease.executionWorkspaceId = randomUUID();
    if (kind === "issue") f.lease.issueId = randomUUID();
    if (kind === "expired") f.lease.expiresAt = new Date(0);
    if (kind === "orphan") row.environment = null;
    if (kind === "released") f.lease.releasedAt = new Date();
    expect(() => selectWorkspaceProgramLease(f.binding, [row])).toThrowError(expect.objectContaining({ details: { code: "workspace_environment_unavailable" } }));
  });
  it("refuses ambiguous active leases, including mixed local and remote placements", () => {
    const f = fixture(), row = { lease: f.lease, environment: f.environment };
    expect(() => selectWorkspaceProgramLease(f.binding, [row, { ...row, environment: { ...f.environment, driver: "local" } }]))
      .toThrowError(expect.objectContaining({ details: { code: "workspace_environment_ambiguous" } }));
  });
  it("retains the recorded remote placement after the lease ends, even with a host mirror", async () => {
    const f = fixture(); const result = await readWorkspaceProgramPlacement(database([], []), f.binding);
    expect(result).toMatchObject({ environment: { id: f.environment.id }, lease: null });
    expect(mocks.getById).toHaveBeenCalledWith(f.environment.id); expect(mocks.ensureLocalEnvironment).not.toHaveBeenCalled();
  });
  it("uses released lease history when a legacy workspace has no realization metadata", async () => {
    const f = fixture(); f.binding.workspace.metadata = null;
    await readWorkspaceProgramPlacement(database([], [], [{ environmentId: f.environment.id }]), f.binding);
    expect(mocks.getById).toHaveBeenCalledWith(f.environment.id); expect(mocks.ensureLocalEnvironment).not.toHaveBeenCalled();
    await expect(readWorkspaceProgramPlacement(database([], [], [{ environmentId: null }]), f.binding))
      .rejects.toMatchObject({ details: { code: "workspace_environment_unavailable" } });
  });
  it("uses the preparation agent's environment before the instance default for an unrealized case", async () => {
    const f = fixture(); f.binding.workspace.metadata = null;
    mocks.get.mockResolvedValue({ general: {}, defaultEnvironmentId: "instance" });
    await readWorkspaceProgramPlacement(database([], [{ id: "author", adapterType: "opencode_local", defaultEnvironmentId: "agent-environment" }]), f.binding);
    expect(mocks.getById).toHaveBeenCalledWith("agent-environment"); expect(mocks.ensureLocalEnvironment).not.toHaveBeenCalled();
  });
  it("does not fall back when a recorded remote environment was removed", async () => {
    const f = fixture(); mocks.getById.mockResolvedValue(null);
    await expect(readWorkspaceProgramPlacement(database([], []), f.binding)).rejects.toMatchObject({ details: { code: "workspace_environment_unavailable" } });
    expect(mocks.ensureLocalEnvironment).not.toHaveBeenCalled();
  });
  it("enforces company and execution policy on the actual acquired provider", () => {
    const f = fixture();
    expect(() => assertWorkspaceProgramEnvironment(f.environment, {}, f.binding.case.companyId, ["foreign"]))
      .toThrowError(expect.objectContaining({ details: { code: "environment_company_mismatch" } }));
    expect(() => assertWorkspaceProgramEnvironment({ ...f.environment, driver: "local" }, { managedSandboxOnly: true }, f.binding.case.companyId, []))
      .toThrowError(expect.objectContaining({ details: { code: "workspace_execution_policy_denied" } }));
    expect(() => assertWorkspaceProgramEnvironment(f.environment, { executionMode: "kubernetes" }, f.binding.case.companyId, [], { ...f.lease, provider: "other-provider" }))
      .toThrowError(expect.objectContaining({ details: { code: "workspace_execution_policy_denied" } }));
    expect(() => assertWorkspaceProgramEnvironment(f.environment, { executionMode: "kubernetes" }, f.binding.case.companyId, [], f.lease)).not.toThrow();
    expect(() => assertWorkspaceProgramEnvironment({ ...f.environment, driver: "local" }, {}, f.binding.case.companyId, [], f.lease))
      .toThrowError(expect.objectContaining({ details: { code: "workspace_environment_unavailable" } }));
  });
  it("applies the policy before either remote execution or host-local fallback", async () => {
    const f = fixture("local"); mocks.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: true });
    await expect(executeWorkspaceRevisionProgram(database([{ lease: f.lease, environment: f.environment }]), f.runtime, f.binding, "throw 'must not run'", {}))
      .rejects.toMatchObject({ details: { code: "workspace_execution_policy_denied" } });
    expect(f.execute).not.toHaveBeenCalled(); expect(mocks.ssh).not.toHaveBeenCalled();
  });
});

describe("fixed programs on realized case workspaces", () => {
  it.each(["active", "unleased", "copy"])("runs credential-free preflight in the same %s sandbox placement before passing auth", async (kind) => {
    const f = fixture();
    if (kind === "copy") {
      const record = { ...f.record, mode: "copy", authoritativeRoot: "/host/mirror", local: { ...f.record.local, path: "/host/mirror" } };
      f.binding.workspace.metadata!.workspaceRealization = record;
      vi.mocked(f.runtime.realizeWorkspace).mockResolvedValue({ cwd: "/connection-root", metadata: { workspaceRealization: record } });
    }
    const env = vi.fn(async (execute: (program: string) => Promise<unknown>) => {
      await execute("preflight"); return { PAPERCLIP_GIT_TOKEN: "fixture-token" };
    });
    await executeWorkspaceRevisionProgram(kind === "active" ? database([{ lease: f.lease, environment: f.environment }]) : database([], []),
      f.runtime, f.binding, "inspection", {}, { env });
    const commands = f.execute.mock.calls.map(([command]) => command as unknown as { args: string[]; cwd: string; env?: Record<string, string> });
    expect(commands[0]).toMatchObject({ args: ["-e", "preflight"], env: undefined });
    expect(commands[1]).toMatchObject({ args: ["-e", "inspection"], cwd: commands[0]!.cwd, env: { PAPERCLIP_GIT_TOKEN: "fixture-token" } });
    expect(f.runtime.acquireRunLease).toHaveBeenCalledTimes(kind === "active" ? 0 : 1);
    expect(f.release).toHaveBeenCalledTimes(kind === "active" ? 0 : 1);
  });
  it("passes host-owned credentials only through the local child environment", async () => {
    const program = "const input=JSON.parse(require('node:fs').readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({authenticated:process.env.PAPERCLIP_GIT_TOKEN==='fixture-token',input}));";
    const result = await runLocalWorkspaceProgram(process.cwd(), program, { value: "request" }, 5000, { PAPERCLIP_GIT_TOKEN: "fixture-token" });
    expect(JSON.parse(result.stdout)).toEqual({ authenticated: true, input: { value: "request" } });
    expect(result.stdout).not.toContain("fixture-token");
  });
  it.each([true, false])("passes host credentials to the authoritative sandbox (active lease: %s)", async (active) => {
    const f = fixture(), env = { PAPERCLIP_GIT_TOKEN: "fixture-token" };
    const db = active ? database([{ lease: f.lease, environment: f.environment }]) : database([], []);
    await executeWorkspaceRevisionProgram(db, f.runtime, f.binding, "fixed-program", { value: "request" }, { env });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ env, stdin: '{"value":"request"}' }));
  });
  it("uses the authoritative in-place root and the staged SSH run path for copies", () => {
    const f = fixture("ssh"); f.lease.heartbeatRunId = "run-1";
    expect(workspaceProgramDirectory(f.binding, f.environment, f.lease)).toBe("/persistent/spec-case");
    f.lease.metadata!.workspaceRealization = { ...f.record, mode: "copy" };
    expect(workspaceProgramDirectory(f.binding, f.environment, f.lease)).toBe("/connection-root/.paperclip-runtime/runs/run-1/workspace");
    f.lease.metadata!.workspaceRealization = { ...f.record, local: { branchName: "another-case" } };
    expect(() => workspaceProgramDirectory(f.binding, f.environment, f.lease)).toThrowError(expect.objectContaining({ details: { code: "workspace_mismatch" } }));
  });
  it("runs an active sandbox lease in place without acquiring or releasing an agent lease", async () => {
    const f = fixture(), payload = { value: "stdin only" };
    expect(await executeWorkspaceRevisionProgram(database([{ lease: f.lease, environment: f.environment }]), f.runtime, f.binding, "fixed-program", payload)).toMatchObject({ exitCode: 0 });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/persistent/spec-case", stdin: JSON.stringify(payload), bypassSession: true }));
    expect(f.runtime.acquireRunLease).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  it("does not accept a successful-looking receipt from a timed-out command", async () => {
    const f = fixture(); f.execute.mockResolvedValue({ exitCode: 0, stdout: '{"ok":true}', timedOut: true } as never);
    expect(await executeWorkspaceRevisionProgram(database([{ lease: f.lease, environment: f.environment }]), f.runtime, f.binding, "fixed", {}))
      .toEqual({ stdout: '{"ok":true}', exitCode: null });
  });
  it("uses the SSH process transport with argument and stdin boundaries", async () => {
    const f = fixture("ssh"), payload = { text: "$(this-is-data)" };
    mocks.driverConfig.mockResolvedValue({ driver: "ssh", config: { host: "case.example", port: 22, username: "agent", remoteWorkspacePath: "/remote" } });
    mocks.ssh.mockResolvedValue({ stdout: '{"ok":true}', exitCode: 0 });
    await runRemoteWorkspaceProgram({} as Db, f.runtime, f.binding, f.environment, f.lease, "/persistent/spec-case", "fixed-program", payload);
    expect(mocks.ssh).toHaveBeenCalledWith(f.lease.id, expect.objectContaining({ transport: "ssh", remoteCwd: "/persistent/spec-case" }), "node", ["-e", "fixed-program"],
      expect.objectContaining({ stdin: JSON.stringify(payload), cwd: "/persistent/spec-case", env: {} }));
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses a moved SSH connection instead of running against another machine", async () => {
    const f = fixture("ssh"); f.lease.metadata!.host = "original.example";
    mocks.driverConfig.mockResolvedValue({ driver: "ssh", config: { host: "different.example" } });
    await expect(runRemoteWorkspaceProgram({} as Db, f.runtime, f.binding, f.environment, f.lease, "/persistent/spec-case", "fixed", {}))
      .rejects.toMatchObject({ details: { code: "workspace_environment_unavailable" } });
    expect(mocks.ssh).not.toHaveBeenCalled();
  });
  it("reacquires and realizes an in-place case with an ad-hoc lease, then releases only that lease", async () => {
    const f = fixture(); await runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", { case: "source" });
    expect(f.runtime.acquireRunLease).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: null, issueId: f.binding.issue.id,
      assertCompanyBinding: true, persistedExecutionWorkspace: { id: f.binding.workspace.id, mode: "isolated_workspace" } }));
    expect(f.runtime.realizeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspace: expect.objectContaining({ remotePath: "/persistent/spec-case" }) }));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/persistent/spec-case" }));
    expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lease: expect.objectContaining({ id: f.lease.id }), status: "released" }));
  });
  it.each(["realization", "execution", "company"])("releases its ad-hoc lease when %s fails", async (failure) => {
    const f = fixture();
    if (failure === "realization") vi.mocked(f.runtime.realizeWorkspace).mockResolvedValue({ cwd: "/different", metadata: {} });
    if (failure === "execution") f.execute.mockRejectedValue(new Error("Remote execution failed"));
    if (failure === "company") mocks.listBoundCompanyIds.mockResolvedValue(["foreign"]);
    await expect(runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", {})).rejects.toBeDefined();
    expect(f.release).toHaveBeenCalledTimes(1);
    if (failure !== "execution") expect(f.execute).not.toHaveBeenCalled();
  });
  it("reports cleanup failure as a resumable boundary instead of a successful publication", async () => {
    const f = fixture(); f.release.mockRejectedValue(new Error("Provider cleanup unavailable"));
    await expect(runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", {}))
      .rejects.toMatchObject({ details: { code: "workspace_environment_release_failed", leaseId: f.lease.id } });
  });
  it("refuses a copy whose authoritative directory differs from its host binding", async () => {
    const f = fixture(); f.binding.workspace.metadata!.workspaceRealization = { ...f.record, mode: "copy" };
    await expect(runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", {}))
      .rejects.toMatchObject({ details: { code: "workspace_mismatch" } });
    expect(f.runtime.acquireRunLease).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["sandbox", "ssh"] as const)("stages an owned %s copy and returns its canonical restoration coordinate", async (driver) => {
    const f = fixture(driver), copyRecord = { ...f.record, mode: "copy", authoritativeRoot: "/host/mirror",
      local: { ...f.record.local, path: "/host/mirror" }, remote: { path: "/connection-root" } };
    f.binding.workspace.metadata!.workspaceRealization = copyRecord;
    vi.mocked(f.runtime.realizeWorkspace).mockResolvedValue({ cwd: "/connection-root", metadata: { workspaceRealization: copyRecord } });
    mocks.driverConfig.mockResolvedValue({ driver: "ssh", config: { host: "case.example", port: 22, username: "agent" } });
    mocks.ssh.mockResolvedValue({ stdout: '{"ok":true}', exitCode: 0 });
    const result = await runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", { mode: "prepare" });
    expect(result).toMatchObject({ exitCode: 0, copyRestoreCwd: "/host/mirror" });
    const staged = mocks.copy.mock.calls[0]![0];
    expect(staged).toMatchObject({ cwd: "/host/mirror", leaseId: f.lease.id });
    expect(staged.remoteDirectory).toContain("/connection-root/.paperclip-runtime/openspec/" + f.lease.id + "/");
    if (driver === "sandbox") expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: staged.remoteDirectory, command: "node", args: ["-e", "fixed"] }));
    else {
      expect(f.execute).not.toHaveBeenCalled();
      expect(mocks.ssh).toHaveBeenCalledWith(f.lease.id, expect.anything(), "node", ["-e", "fixed"], expect.objectContaining({ cwd: staged.remoteDirectory }));
    }
    expect(mocks.updateLeaseMetadata).toHaveBeenLastCalledWith(f.lease.id, expect.objectContaining({ workspaceProgramCopy: {
      leaseId: f.lease.id, workspaceId: f.binding.workspace.id, directory: staged.remoteDirectory,
    } }));
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("releases the owned copy lease when staging fails, without executing the source program", async () => {
    const f = fixture(), copyRecord = { ...f.record, mode: "copy", authoritativeRoot: "/host/mirror", local: { ...f.record.local, path: "/host/mirror" } };
    f.binding.workspace.metadata!.workspaceRealization = copyRecord;
    vi.mocked(f.runtime.realizeWorkspace).mockResolvedValue({ cwd: "/connection-root", metadata: { workspaceRealization: copyRecord } });
    mocks.copy.mockRejectedValueOnce(new Error("Git staging failed"));
    await expect(runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", {})).rejects.toThrow("Git staging failed");
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });
  it("returns restoration metadata for an already active copy without releasing the borrowed lease", async () => {
    const f = fixture(); f.lease.metadata!.workspaceRealization = { ...f.record, mode: "copy", authoritativeRoot: "/host/mirror",
      local: { ...f.record.local, path: "/host/mirror" } };
    f.lease.metadata!.workspaceProgramCopy = { leaseId: f.lease.id, workspaceId: f.binding.workspace.id, directory: "/connection-root/owned-stage" };
    const result = await executeWorkspaceRevisionProgram(database([{ lease: f.lease, environment: f.environment }]), f.runtime, f.binding, "fixed", {});
    expect(result).toMatchObject({ copyRestoreCwd: "/host/mirror" });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/connection-root/owned-stage" }));
    expect(f.runtime.acquireRunLease).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  it("uses the workspace's recorded realization for legacy leases and refuses a wholly unknown mode", async () => {
    const f = fixture(); f.lease.metadata!.workspaceRealization = {};
    expect(workspaceProgramDirectory(f.binding, f.environment, f.lease)).toBe("/persistent/spec-case");
    f.binding.workspace.metadata = null;
    await expect(executeWorkspaceRevisionProgram(database([{ lease: f.lease, environment: f.environment }]), f.runtime, f.binding, "fixed", {}))
      .rejects.toMatchObject({ details: { code: "workspace_environment_unrealized" } });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("keeps acquisition and realization inside the command's original deadline", async () => {
    const f = fixture(), deadline = Date.now() + 120_000;
    vi.mocked(f.runtime.realizeWorkspace).mockImplementation(async () => {
      f.lease.expiresAt = new Date(0);
      return { cwd: f.record.authoritativeRoot, metadata: { workspaceRealization: f.record } };
    });
    await expect(runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", {}, deadline))
      .rejects.toMatchObject({ details: { code: "workspace_environment_unavailable" } });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("does not acquire a lease after the operation deadline already expired", async () => {
    const f = fixture();
    await expect(runUnleasedWorkspaceProgram({} as Db, f.runtime, f.binding, f.placement, "fixed", {}, Date.now() - 10))
      .rejects.toMatchObject({ details: { code: "workspace_environment_unavailable" } });
    expect(f.runtime.acquireRunLease).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
});
