import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  inspectWorktreeHealth,
  probeWorktreeGitLocks,
  worktreeHealthHasUnsavedWork,
  worktreeHealthIsLocked,
} from "./workspace-health.js";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
});

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-health-"));
  tempRoots.push(repoRoot);
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  return repoRoot;
}

async function resolveGitPath(repoRoot: string, gitPath: string) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", gitPath], { cwd: repoRoot });
  const resolved = stdout.trim();
  return path.isAbsolute(resolved) ? resolved : path.resolve(repoRoot, resolved);
}

describe("inspectWorktreeHealth", () => {
  it("reports a committed worktree as clean with no locks held", async () => {
    const repoRoot = await createTempRepo();

    const health = await inspectWorktreeHealth(repoRoot);

    expect(health.cleanliness).toBe("clean");
    expect(health.statusEntryCount).toBe(0);
    expect(health.dirtyPathSample).toEqual([]);
    expect(health.inProgressOperation).toBeNull();
    expect(health.indexLock.state).toBe("free");
    expect(health.headLock.state).toBe("free");
    expect(worktreeHealthHasUnsavedWork(health)).toBe(false);
    expect(worktreeHealthIsLocked(health)).toBe(false);
  });

  it("counts untracked files even when the repository hides them from status", async () => {
    const repoRoot = await createTempRepo();
    // The realistic shape of an interrupted agent's tree: the work that matters
    // is a file git has never seen. `status.showUntrackedFiles=no` is the local
    // setting that would hide it, so the probe must force
    // `--untracked-files=all` rather than trust the repository's default.
    await runGit(repoRoot, ["config", "status.showUntrackedFiles", "no"]);
    await fs.writeFile(path.join(repoRoot, "new-feature.ts"), "export const x = 1;\n", "utf8");

    const health = await inspectWorktreeHealth(repoRoot);

    expect(health.cleanliness).toBe("dirty");
    expect(health.statusEntryCount).toBe(1);
    expect(health.dirtyPathSample).toEqual(["new-feature.ts"]);
    expect(worktreeHealthHasUnsavedWork(health)).toBe(true);
  });

  it("samples modified, staged and untracked paths together", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "README.md"), "hello again\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "staged.txt"), "staged\n", "utf8");
    await runGit(repoRoot, ["add", "staged.txt"]);
    await fs.writeFile(path.join(repoRoot, "untracked.txt"), "untracked\n", "utf8");

    const health = await inspectWorktreeHealth(repoRoot);

    expect(health.cleanliness).toBe("dirty");
    expect(health.statusEntryCount).toBe(3);
    expect([...health.dirtyPathSample].sort()).toEqual(["README.md", "staged.txt", "untracked.txt"]);
  });

  it("detects a held index.lock without taking or clearing it", async () => {
    const repoRoot = await createTempRepo();
    const indexLockPath = await resolveGitPath(repoRoot, "index.lock");
    await fs.writeFile(indexLockPath, "", "utf8");

    const health = await inspectWorktreeHealth(repoRoot);

    expect(health.indexLock.state).toBe("held");
    expect(health.indexLock.path).toBe(indexLockPath);
    expect(health.headLock.state).toBe("free");
    expect(worktreeHealthIsLocked(health)).toBe(true);
    // Detection must not be acquisition: the lock file is still there afterwards.
    await expect(fs.stat(indexLockPath)).resolves.toBeTruthy();
  });

  it("detects a held HEAD.lock, which no realization path inspects today", async () => {
    const repoRoot = await createTempRepo();
    const headLockPath = await resolveGitPath(repoRoot, "HEAD.lock");
    await fs.writeFile(headLockPath, "", "utf8");

    const health = await inspectWorktreeHealth(repoRoot);

    expect(health.headLock.state).toBe("held");
    expect(health.headLock.path).toBe(headLockPath);
    expect(worktreeHealthIsLocked(health)).toBe(true);

    await fs.rm(headLockPath, { force: true });
  });

  it("reports an interrupted git operation", async () => {
    const repoRoot = await createTempRepo();
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    await fs.writeFile(await resolveGitPath(repoRoot, "MERGE_HEAD"), `${headSha}\n`, "utf8");

    const health = await inspectWorktreeHealth(repoRoot);

    expect(health.inProgressOperation).toBe("merge");
    expect(worktreeHealthHasUnsavedWork(health)).toBe(true);
  });

  it("fails to unknown, never to clean, when the probe cannot run", async () => {
    // A path that does not exist is the deterministic stand-in for every way git
    // can fail here. The assertion that matters is the negative one: "clean" is
    // the reading that unlocks `reset --hard`, so a failed probe must never
    // produce it. This is the same rule the herdr prober encodes by forcing
    // BLD=-1 on a failed status (paperclip-herdr-adapter/src/pane-git.ts:252-254).
    const missingPath = path.join(os.tmpdir(), `paperclip-worktree-health-missing-${process.pid}`);

    const health = await inspectWorktreeHealth(missingPath);

    expect(health.cleanliness).toBe("unknown");
    expect(health.cleanliness).not.toBe("clean");
    expect(health.statusEntryCount).toBeNull();
    expect(health.indexLock.state).toBe("unknown");
    expect(health.headLock.state).toBe("unknown");
    expect(worktreeHealthHasUnsavedWork(health)).toBe(true);
    expect(worktreeHealthIsLocked(health)).toBe(true);
  });
});

describe("probeWorktreeGitLocks", () => {
  it("re-reads both locks and sees a removal the full probe would also have seen", async () => {
    // The caller for this is the lock repair in workspace-runtime.ts, which
    // clears an abandoned lock and then has to establish whether the clearing
    // took — a question that must not cost a second `git status` over the tree.
    const repoRoot = await createTempRepo();
    const indexLockPath = await resolveGitPath(repoRoot, "index.lock");
    await fs.writeFile(indexLockPath, "", "utf8");

    const held = await probeWorktreeGitLocks(repoRoot);
    expect(held.indexLock.state).toBe("held");
    expect(held.indexLock.path).toBe(indexLockPath);
    expect(held.headLock.state).toBe("free");

    await fs.rm(indexLockPath, { force: true });

    const cleared = await probeWorktreeGitLocks(repoRoot);
    expect(cleared.indexLock.state).toBe("free");
    expect(worktreeHealthIsLocked({ ...await inspectWorktreeHealth(repoRoot), ...cleared })).toBe(false);
  });

  it("fails to unknown, never to free, when git cannot resolve the paths", async () => {
    const missingPath = path.join(os.tmpdir(), `paperclip-worktree-locks-missing-${process.pid}`);

    const locks = await probeWorktreeGitLocks(missingPath);

    expect(locks.indexLock.state).toBe("unknown");
    expect(locks.headLock.state).toBe("unknown");
    expect(locks.indexLock.path).toBeNull();
  });
});
