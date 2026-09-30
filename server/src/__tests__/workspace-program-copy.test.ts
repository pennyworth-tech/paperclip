import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceProgramCopy } from "../services/workspace-program-copy.js";

describe("workspace copy repository identity and transport", () => {
  let root: string, commitSha: string;
  const repositorySsh = "git@github.com:fixture/spec.git", branch = "fixture-branch", changeId = "fixture-change";
  const git = (cwd: string, ...args: string[]) => execFileSync("git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const request = () => ({ repositorySsh, branch, changeId, commitSha });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workspace-copy-test-")));
    git(root, "init", "-q", "-b", branch); git(root, "config", "user.name", "Copy Fixture");
    git(root, "config", "user.email", "copy@example.invalid"); git(root, "remote", "add", "origin", repositorySsh);
    const change = path.join(root, "openspec/changes", changeId);
    await fs.mkdir(change, { recursive: true });
    await fs.writeFile(path.join(change, ".openspec.yaml"), "schema: spec-driven\n");
    await fs.writeFile(path.join(change, "proposal.md"), "# Copy fixture\n");
    git(root, "add", "."); git(root, "commit", "-qm", "Fixture source"); commitSha = git(root, "rev-parse", "HEAD");
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

  it.each([repositorySsh, "git@github.com:fixture/spec", "https://github.com/fixture/spec.git",
    "https://github.com/fixture/spec"])("preserves %s in the canonical workspace and its copy", async (url) => {
    git(root, "remote", "set-url", "origin", url);
    let copied: string | undefined;
    await withWorkspaceProgramCopy(root, request(), Date.now() + 30_000, async (snapshot, depth) => {
      copied = snapshot;
      expect(git(snapshot, "config", "--get", "remote.origin.url")).toBe(url);
      expect(git(snapshot, "symbolic-ref", "--short", "HEAD")).toBe(branch);
      expect(git(snapshot, "rev-parse", "HEAD")).toBe(commitSha);
      expect(depth).toBeGreaterThanOrEqual(2);
    });
    expect(git(root, "config", "--get", "remote.origin.url")).toBe(url);
    expect(git(root, "rev-parse", "HEAD")).toBe(commitSha);
    expect(git(root, "status", "--porcelain")).toBe("");
    await expect(fs.access(copied!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["https://github.com/other/spec.git", "https://user:token@github.com/fixture/spec.git",
    "https://github.com/fixture/spec.git?ref=other", "https://github.com.evil.test/fixture/spec.git"])("rejects %s before using a copy", async (url) => {
    git(root, "remote", "set-url", "origin", url);
    const use = vi.fn();
    await expect(withWorkspaceProgramCopy(root, request(), Date.now() + 30_000, use))
      .rejects.toMatchObject({ details: { code: "workspace_mismatch" } });
    expect(use).not.toHaveBeenCalled();
    expect(git(root, "config", "--get", "remote.origin.url")).toBe(url);
  });
  it("rejects canonical repository filters before staging can execute them", async () => {
    await fs.writeFile(path.join(root, ".gitattributes"), "payload.txt filter=fixture\n");
    await fs.writeFile(path.join(root, "payload.txt"), "tracked\n");
    git(root, "add", "."); git(root, "commit", "-qm", "Fixture attributes"); commitSha = git(root, "rev-parse", "HEAD");
    const marker = path.join(root, ".git/filter-credential");
    git(root, "config", "filter.fixture.clean", "printf '%s' \"$PAPERCLIP_GIT_TOKEN\" > '" + marker + "'; cat");
    await fs.writeFile(path.join(root, "replacement.txt"), "tracked\n");
    await fs.rename(path.join(root, "replacement.txt"), path.join(root, "payload.txt"));
    vi.stubEnv("PAPERCLIP_GIT_TOKEN", "fixture-token");
    const use = vi.fn();
    await expect(withWorkspaceProgramCopy(root, request(), Date.now() + 30_000, use))
      .rejects.toMatchObject({ details: { code: "git_transport_override" } });
    expect(use).not.toHaveBeenCalled();
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
