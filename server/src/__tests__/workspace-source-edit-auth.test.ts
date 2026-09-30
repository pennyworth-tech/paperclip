import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { workspaceSourceEditAuthEnv, workspaceSourceEditOriginProgram } from "../services/workspace-source-edit-auth.js";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), auth: vi.fn() }));
vi.mock("../services/git-credentials.js", async (original) => ({
  ...await original<typeof import("../services/git-credentials.js")>(), createGitRemoteAuthProvider: mocks.provider,
}));
beforeEach(() => {
  vi.clearAllMocks(); mocks.provider.mockReturnValue(mocks.auth);
  mocks.auth.mockResolvedValue(buildGitAuthInvocation({ token: "fixture-source-token", source: "company_secret", secretName: "GITHUB_TOKEN" }));
});
function fixture(remoteUrl = "https://github.com/fixture/spec") {
  const db = {} as Db, context = { issueId: "issue", heartbeatRunId: null, responsibleUserId: "operator" };
  const validate = vi.fn(async () => context);
  const preflight = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, remoteUrl }), exitCode: 0 as number | null }));
  const env = workspaceSourceEditAuthEnv(db, "company", "git@github.com:fixture/spec.git", validate);
  if (typeof env !== "function") throw new Error("Expected lazy auth");
  return { db, context, validate, preflight, resolve: () => env(preflight) };
}
describe("source publication credentials", () => {
  it("waits for origin and writer validation, and provides working auth only in the child environment", async () => {
    const f = fixture(), env = await f.resolve();
    expect(f.preflight).toHaveBeenCalledWith(workspaceSourceEditOriginProgram);
    expect(f.preflight.mock.invocationCallOrder[0]).toBeLessThan(f.validate.mock.invocationCallOrder[0]!);
    expect(f.validate.mock.invocationCallOrder[0]).toBeLessThan(mocks.provider.mock.invocationCallOrder[0]!);
    expect(mocks.provider).toHaveBeenCalledWith(f.db, "company", f.context);
    expect(mocks.auth).toHaveBeenCalledWith("https://github.com/fixture/spec");
    const result = execFileSync("git", ["credential", "fill"], { cwd: os.tmpdir(), encoding: "utf8",
      env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      input: "protocol=https\nhost=github.com\n\n", stdio: ["pipe", "pipe", "pipe"] });
    expect(result).toContain("password=fixture-source-token");
    expect(workspaceSourceEditOriginProgram).not.toContain("fixture-source-token");
  });
  it("does not resolve a token for SSH", async () => {
    const f = fixture("git@github.com:fixture/spec.git");
    expect(await f.resolve()).toEqual({ PAPERCLIP_WORKSPACE_EDIT_ORIGIN: "git@github.com:fixture/spec.git" });
    expect(f.validate).toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
  });
  it.each(["git_transport_override", "repository_mismatch"])("does not resolve a credential after %s", async (code) => {
    const f = fixture(); f.preflight.mockResolvedValue({ exitCode: 1, stdout: JSON.stringify({ ok: false, code }) });
    await expect(f.resolve()).rejects.toMatchObject({ details: { code } });
    expect(f.validate).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("fails closed on a timed-out preflight or a changed writer", async () => {
    const timeout = fixture(); timeout.preflight.mockResolvedValue({ exitCode: null, stdout: JSON.stringify({ ok: true, remoteUrl: "https://github.com/fixture/spec" }) });
    await expect(timeout.resolve()).rejects.toMatchObject({ details: { code: "source_edit_failed" } });
    const stale = fixture(); stale.validate.mockRejectedValue(new Error("writer changed"));
    await expect(stale.resolve()).rejects.toThrow("writer changed"); expect(mocks.provider).not.toHaveBeenCalled();
  });
});
