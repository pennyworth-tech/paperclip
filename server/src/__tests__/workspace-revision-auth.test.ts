import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { workspaceRevisionInspectionService } from "../services/workspace-revision-inspection.js";

const mocks = vi.hoisted(() => ({ binding: vi.fn(), execute: vi.fn(), preflight: vi.fn(), childEnv: vi.fn(), provider: vi.fn(), auth: vi.fn(), audit: vi.fn() }));
vi.mock("../services/workspace-revision-context.js", async (original) => ({
  ...await original<typeof import("../services/workspace-revision-context.js")>(),
  readWorkspaceRevisionBinding: mocks.binding, executeWorkspaceRevisionProgram: mocks.execute,
}));
vi.mock("../services/git-credentials.js", async (original) => ({
  ...await original<typeof import("../services/git-credentials.js")>(), createGitRemoteAuthProvider: mocks.provider,
}));

beforeEach(() => {
  vi.clearAllMocks(); mocks.provider.mockReturnValue(mocks.auth);
  mocks.auth.mockResolvedValue(buildGitAuthInvocation({ token: "fixture-token", source: "company_secret", secretName: "GITHUB_TOKEN" }));
  mocks.binding.mockResolvedValue({ issue: { id: "issue", checkoutRunId: "run" } });
  mocks.preflight.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ ok: true, remoteUrl: "https://github.com/fixture/spec.git" }) });
  mocks.execute.mockImplementation(async (_db, _runtime, _binding, _program, _input, options) => {
    mocks.childEnv(await options.env(mocks.preflight));
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { commitSha: "a".repeat(40) } }) };
  });
});
function fixture() {
  const companyId = randomUUID(), workspaceId = randomUUID();
  const input = { caseId: randomUUID(), expectedVersion: 1, expectedTurn: 0, commitSha: "a".repeat(40),
    repositorySsh: "git@github.com:fixture/spec.git", branch: "ticket-branch", changeId: "fixture-spec" };
  const db = { insert: () => ({ values: mocks.audit }) } as unknown as Db;
  const service = workspaceRevisionInspectionService(db, { pluginId: randomUUID(), pluginKey: "fixture.plugin" }, {} as EnvironmentRuntimeService);
  return { companyId, workspaceId, input, db, inspect: () => service.inspect(workspaceId, companyId, input), service };
}

describe("company credentials for committed workspace inspection", () => {
  it("uses existing company auth only after ownership checks and keeps it out of requests and receipts", async () => {
    const f = fixture(), result = await f.inspect();
    expect(mocks.binding.mock.invocationCallOrder[0]).toBeLessThan(mocks.provider.mock.invocationCallOrder[0]!);
    expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(mocks.provider.mock.invocationCallOrder[0]!);
    expect(mocks.provider).toHaveBeenCalledWith(f.db, f.companyId, { issueId: "issue", heartbeatRunId: "run" });
    expect(mocks.auth).toHaveBeenCalledWith("https://github.com/fixture/spec.git");
    const [, , , program, input] = mocks.execute.mock.calls[0]!;
    expect(mocks.childEnv.mock.calls[0]![0].PAPERCLIP_GIT_TOKEN).toBe("fixture-token");
    expect(JSON.stringify([program, input, result, mocks.audit.mock.calls])).not.toContain("fixture-token");
    expect(mocks.binding).toHaveBeenCalledTimes(3);
  });
  it("provides a working URL-scoped helper through the child environment without saving credentials", async () => {
    await fixture().inspect();
    const env = mocks.childEnv.mock.calls[0]![0];
    const output = execFileSync("git", ["credential", "fill"], { cwd: os.tmpdir(),
      env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    expect(output).toContain("password=fixture-token");
  });
  it("does not resolve credentials for a workspace the caller does not own", async () => {
    mocks.binding.mockRejectedValueOnce(new Error("workspace denied"));
    await expect(fixture().inspect()).rejects.toThrow("workspace denied");
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not accept plugin-supplied environment variables", async () => {
    const f = fixture();
    await expect(f.service.inspect(f.workspaceId, f.companyId, { ...f.input, env: { GITHUB_TOKEN: "untrusted" } }))
      .rejects.toMatchObject({ details: { code: "validation" } });
    expect(mocks.binding).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("preserves ambient behavior when no existing credential is available", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    await fixture().inspect();
    expect(mocks.childEnv.mock.calls[0]![0]).toEqual({ PAPERCLIP_WORKSPACE_INSPECTION_ORIGIN: "https://github.com/fixture/spec.git" });
  });
  it("does not resolve or pass a GitHub token for an actual SSH origin", async () => {
    mocks.preflight.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ ok: true, remoteUrl: "git@github.com:fixture/spec.git" }) });
    await fixture().inspect();
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.childEnv.mock.calls[0]![0]).toEqual({ PAPERCLIP_WORKSPACE_INSPECTION_ORIGIN: "git@github.com:fixture/spec.git" });
  });
  it("resolves auth for the actual HTTPS origin without adding a .git suffix", async () => {
    mocks.preflight.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ ok: true, remoteUrl: "https://github.com/fixture/spec" }) });
    await fixture().inspect(); expect(mocks.auth).toHaveBeenCalledWith("https://github.com/fixture/spec");
  });
  it.each(["repository_mismatch", "git_transport_override", "revision_conflict"])("does not resolve credentials after %s preflight failure", async (code) => {
    mocks.preflight.mockResolvedValueOnce({ exitCode: 1, stdout: JSON.stringify({ ok: false, code }) });
    await expect(fixture().inspect()).rejects.toMatchObject({ details: { code } });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.childEnv).not.toHaveBeenCalled();
  });
  it("refuses a timed-out preflight even if its receipt looks successful", async () => {
    mocks.preflight.mockResolvedValueOnce({ exitCode: null, stdout: JSON.stringify({ ok: true, remoteUrl: "https://github.com/fixture/spec.git" }) });
    await expect(fixture().inspect()).rejects.toMatchObject({ details: { code: "source_inspection_failed" } });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.childEnv).not.toHaveBeenCalled();
  });
  it("rechecks ownership after preflight before resolving a credential", async () => {
    mocks.binding.mockResolvedValueOnce({ issue: { id: "issue", checkoutRunId: "run" } });
    mocks.binding.mockResolvedValueOnce({ issue: { id: "issue", checkoutRunId: "different-run" } });
    await expect(fixture().inspect()).rejects.toMatchObject({ details: { code: "source_inspection_stale" } });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.childEnv).not.toHaveBeenCalled();
  });
});
