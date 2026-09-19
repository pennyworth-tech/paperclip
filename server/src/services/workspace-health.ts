import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitWorktreeInProgressOperation } from "@paperclipai/shared";
import { workspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";

/**
 * Branch-agnostic state of one git worktree on disk.
 *
 * This is the state-gathering half of `inspectGitWorktreeBranchIncoherence`,
 * hoisted out of that function so it can run on a path that has no branch
 * mismatch at all. The gathering was already complete there — porcelain status,
 * a dirty-path sample, a cleanliness tri-state, an interrupted-operation probe —
 * it was merely unreachable unless the recorded branch and HEAD had already
 * diverged. A resumed run lands on the *same* branch it left, so every one of
 * those probes was skipped on exactly the path that needs them most.
 *
 * FAIL TO UNKNOWN, NEVER TO CLEAN. Every probe here reports "unknown" when its
 * git command fails. That rule is copied from the herdr pane prober
 * (packages/paperclip-herdr-adapter/src/pane-git.ts:252-254), whose comment
 * states the reason exactly:
 *
 *   "`wc -l` on a failed git would report 0, and 0 dirty files is exactly the
 *    state that unlocks `git reset --hard`. The second invocation is what turns
 *    'git failed' into -1 instead of 'clean'."
 *
 * The consequence for every caller: treat "unknown" like "dirty" before doing
 * anything destructive. A probe that could not read the tree has not proven the
 * tree is empty of work.
 */
export type WorktreeHealth = {
  /** "unknown" means the status command failed, not that the tree is clean. */
  cleanliness: "clean" | "dirty" | "unknown";
  /** Porcelain entry count, or null when the status command failed. */
  statusEntryCount: number | null;
  dirtyPathSample: string[];
  inProgressOperation: GitWorktreeInProgressOperation | null;
  /**
   * Lock detection exists nowhere on today's realization paths.
   * `assertGitIndexIsUnlocked` in workspace-runtime.ts throws on index.lock, but
   * it is reachable from a single call site and only under branch mismatch AND a
   * dirty tree AND the dirty-quarantine flag; HEAD.lock is never inspected at
   * all. Both are detected here, and neither throws: a lock is evidence the
   * caller weighs, not a verdict the prober reaches on its own.
   *
   * The caller that weighs it on the dispatch paths is
   * the dispatch gate, which
   * clears an abandoned lock and refuses the workspace when it cannot. Reporting
   * here and gating there is deliberate: this file never mutates a worktree.
   */
  indexLock: WorktreeLockProbe;
  headLock: WorktreeLockProbe;
};

export type WorktreeLockProbe = {
  /** "unknown" means `git rev-parse --git-path` failed, so the path is unknown. */
  state: "held" | "free" | "unknown";
  path: string | null;
};

export type InspectWorktreeHealthOptions = {
  /**
   * Scheduler operation label for the porcelain status. Callers that already had
   * a label keep it so scheduler accounting does not shift under the hoist.
   */
  operation?: string;
  /** Stable scheduling dimensions (workspace/issue lanes) for status fairness. */
  fairnessKeys?: readonly string[];
};

const execFileAsync = promisify(execFile);

const DEFAULT_WORKTREE_HEALTH_STATUS_OPERATION = "workspace_runtime.worktree_health_status";

const DIRTY_PATH_SAMPLE_LIMIT = 5;

const GIT_IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{
  operation: GitWorktreeInProgressOperation;
  marker: string;
}> = [
  { operation: "rebase", marker: "rebase-merge" },
  { operation: "rebase", marker: "rebase-apply" },
  { operation: "merge", marker: "MERGE_HEAD" },
  { operation: "cherry_pick", marker: "CHERRY_PICK_HEAD" },
  { operation: "revert", marker: "REVERT_HEAD" },
  { operation: "bisect", marker: "BISECT_LOG" },
];

/**
 * Resolve one `$GIT_DIR`-relative path for a worktree. Returns null when git
 * cannot answer, which the callers turn into "unknown" rather than "absent":
 * a path we could not resolve is not a lock we proved is missing.
 */
async function resolveGitPath(worktreePath: string, gitPath: string): Promise<string | null> {
  const resolved = await execFileAsync("git", ["rev-parse", "--git-path", gitPath], { cwd: worktreePath })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  if (!resolved) return null;
  return path.isAbsolute(resolved) ? resolved : path.resolve(worktreePath, resolved);
}

/**
 * Detect a lock file without taking or clearing it. The `rev-parse --git-path`
 * plus `existsSync` shape is the one `assertGitIndexIsUnlocked` already uses and
 * the one `acquireGitWorktreeCleanupLock` uses to build its lock list, both in
 * workspace-runtime.ts; the only difference here is that this reports the state
 * instead of throwing on it or claiming it.
 */
async function probeGitLock(worktreePath: string, gitPath: string): Promise<WorktreeLockProbe> {
  const lockPath = await resolveGitPath(worktreePath, gitPath);
  if (!lockPath) return { state: "unknown", path: null };
  return { state: existsSync(lockPath) ? "held" : "free", path: lockPath };
}

/**
 * Re-read just the two native git locks, without the porcelain status.
 *
 * Exists for the caller that has already cleared an abandoned lock and needs to
 * know whether the clearing actually took. Re-running `inspectWorktreeHealth`
 * would answer that too, at the cost of a second `git status` over the whole
 * worktree — the one command in the probe that is expensive enough to be
 * scheduled for fairness.
 */
export async function probeWorktreeGitLocks(
  worktreePath: string,
): Promise<Pick<WorktreeHealth, "indexLock" | "headLock">> {
  const [indexLock, headLock] = await Promise.all([
    probeGitLock(worktreePath, "index.lock"),
    probeGitLock(worktreePath, "HEAD.lock"),
  ]);
  return { indexLock, headLock };
}

function parseGitPorcelainPath(line: string) {
  const raw = line.trimEnd();
  if (raw.trim().length <= 3) return raw.trim();
  if (raw[1] === " " && raw[2] !== " ") return raw.slice(2).trim();
  return raw.slice(3).trim();
}

function sampleDirtyStatusPaths(statusLines: string[] | null) {
  return (statusLines ?? [])
    .map(parseGitPorcelainPath)
    .filter((value) => value.length > 0)
    .slice(0, DIRTY_PATH_SAMPLE_LIMIT);
}

/**
 * Whether an interrupted git operation (rebase/merge/cherry-pick/revert/bisect)
 * still owns this worktree. Exported because the dirty-quarantine path in
 * workspace-runtime.ts re-checks it after its rescue commit.
 */
export async function detectGitWorktreeInProgressOperation(
  worktreePath: string,
): Promise<GitWorktreeInProgressOperation | null> {
  for (const { operation, marker } of GIT_IN_PROGRESS_OPERATION_MARKERS) {
    const markerPath = await resolveGitPath(worktreePath, marker);
    if (!markerPath) continue;
    if (existsSync(markerPath)) return operation;
  }
  return null;
}

/** True for any health reading that has not proven the worktree holds no work. */
export function worktreeHealthHasUnsavedWork(health: WorktreeHealth): boolean {
  return health.cleanliness !== "clean" || health.inProgressOperation !== null;
}

/** True when either native git lock is held or could not be resolved. */
export function worktreeHealthIsLocked(health: WorktreeHealth): boolean {
  return health.indexLock.state !== "free" || health.headLock.state !== "free";
}

/**
 * Plain-language description of a worktree's state, for operator-facing
 * warnings. A dirty tree is not phrased as a fault: on a resume it is the
 * expected state and the runtime preserves it in place.
 */
export function describeWorktreeHealth(health: WorktreeHealth): string {
  const parts: string[] = [];
  if (health.cleanliness === "dirty") {
    const count = health.statusEntryCount;
    parts.push(
      count === null
        ? "uncommitted changes"
        : `${count} uncommitted ${count === 1 ? "entry" : "entries"}`,
    );
  } else if (health.cleanliness === "unknown") {
    parts.push("an unreadable git status (treated as if it held uncommitted work)");
  }
  if (health.inProgressOperation) parts.push(`an interrupted git ${health.inProgressOperation.replace("_", "-")}`);
  if (health.indexLock.state === "held") parts.push("a held git index.lock");
  if (health.headLock.state === "held") parts.push("a held git HEAD.lock");
  if (parts.length === 0) return "a clean worktree with no git locks held";
  return parts.join(", ");
}

/**
 * Gather every branch-agnostic fact about a worktree in one pass.
 *
 * Never throws: a worktree that cannot be probed reports "unknown" on every
 * field it could not read, so a caller that fails closed on "unknown" fails
 * closed here too.
 */
export async function inspectWorktreeHealth(
  worktreePath: string,
  options?: InspectWorktreeHealthOptions,
): Promise<WorktreeHealth> {
  // `--untracked-files=all` is forced so untracked work is counted regardless of
  // a repository-local `status.showUntrackedFiles=no`. Without it a tree holding
  // nothing but new files reports clean, and "clean" is what unlocks the
  // destructive repairs.
  const status = await workspaceGitOperationScheduler
    .run({
      workspacePath: worktreePath,
      args: ["status", "--porcelain", "--untracked-files=all"],
      operation: options?.operation ?? DEFAULT_WORKTREE_HEALTH_STATUS_OPERATION,
      fairnessKeys: options?.fairnessKeys,
      cacheTtlMs: 0,
    })
    .then((result) => result.stdout.trim())
    .catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const cleanliness: WorktreeHealth["cleanliness"] =
    status === null ? "unknown" : status.length > 0 ? "dirty" : "clean";

  const [inProgressOperation, locks] = await Promise.all([
    detectGitWorktreeInProgressOperation(worktreePath),
    probeWorktreeGitLocks(worktreePath),
  ]);

  return {
    cleanliness,
    statusEntryCount: statusLines?.length ?? null,
    dirtyPathSample: sampleDirtyStatusPaths(statusLines),
    inProgressOperation,
    ...locks,
  };
}
