import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { prepareCommandManagedRuntime, type CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { conflict } from "../errors.js";
import { readSourceEditRecovery, type SourceEditProgramInput, type WorkspaceProgramExecution } from "./workspace-source-edit-recovery.js";
import { sameWorkspaceRepository } from "./workspace-repository.js";

const exec = promisify(execFile);
const coordinates = z.object({ commitSha: z.string().regex(/^[a-f0-9]{40}$/), branch: z.string().min(1).max(200),
  repositorySsh: z.string().regex(/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
  changeId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/), mode: z.string().optional() }).passthrough();

/** Git-only host transport. No repository command, renderer, or CLI is executed
 * here. Pin a private snapshot to the original source commit so the adapter's
 * shallow transfer also retains the prerequisite for a recovered candidate. */
export async function withWorkspaceProgramCopy<T>(cwd: string, input: unknown, deadline: number, use: (snapshot: string, historyDepth: number) => Promise<T>): Promise<T> {
  const parsed = coordinates.safeParse(input);
  if (!parsed.success) throw conflict("Invalid workspace copy coordinates", { code: "workspace_mismatch" });
  const request = parsed.data;
  if (request.mode === "abort" || request.mode === "restore") throw conflict("This operation requires its original workspace journal", { code: "source_edit_legacy_copy_unavailable" });
  const recovery = request.mode === "apply" ? readSourceEditRecovery(request.recovery, input as SourceEditProgramInput) : undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] as const) delete env[key];
  const git = async (args: string[], directory = cwd) => {
    const timeout = Math.min(90_000, deadline - Date.now());
    if (timeout < 1000) throw conflict("Workspace staging deadline expired", { code: "workspace_environment_unavailable" });
    try { return (await exec("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: directory, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch { throw conflict("The canonical workspace could not be staged", { code: "workspace_copy_failed" }); }
  };
  const remoteUrl = (await git(["config", "--get", "remote.origin.url"])).trim();
  if (await fs.realpath(cwd) !== await fs.realpath((await git(["rev-parse", "--show-toplevel"])).trim())
    || (await git(["symbolic-ref", "--short", "HEAD"])).trim() !== request.branch
    || !sameWorkspaceRepository(remoteUrl, request.repositorySsh)) {
    throw conflict("The canonical workspace does not match this source", { code: "workspace_mismatch" });
  }
  const localConfig = await git(["config", "--show-scope", "--list"]);
  if (localConfig.split(/\r?\n/).some((line) => /^(local|worktree)\s+(?:credential\.|http\.|core\.(?:askpass|sshcommand)=|filter\..*\.(?:clean|process)=|url\..*\.(?:insteadof|pushinsteadof)=|remote\.origin\.(?:proxy|pushurl)=)/.test(line))) {
    throw conflict("The canonical workspace has unsafe Git configuration", { code: "git_transport_override" });
  }
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (head !== request.commitSha && head !== recovery?.commitSha) throw conflict("The canonical source moved", { code: "edit_base_conflict" });
  const unchanged = async () => {
    if ((await git(["config", "--get", "remote.origin.url"])).trim() !== remoteUrl) throw conflict("The canonical workspace origin changed", { code: "workspace_mismatch" });
    if ((await git(["rev-parse", "HEAD"])).trim() !== head || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
      throw conflict("The canonical workspace has concurrent changes", { code: "workspace_dirty" });
    }
    if ((await git(["ls-files", "-v", "-z"])).split("\0").some((entry) => entry && !entry.startsWith("H "))) {
      throw conflict("The workspace has unsupported index flags", { code: "workspace_index_unsupported" });
    }
  };
  await unchanged();
  const changeRoot = "openspec/changes/" + request.changeId;
  const sourceCommit = (await git(["log", "-1", "--format=%H", request.commitSha, "--",
    "openspec/config.yaml", changeRoot, "openspec/schemas"])).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw conflict("The source history is missing", { code: "source_history_missing" });
  // Preserve all intervening commits and one parent beyond the last source
  // change. A depth-one copy treats the deck commit as a root and breaks the
  // inspector's path-history proof (including deletion-only source changes).
  // A custom schema can declare outputs outside the standard artifact names.
  // Retaining the change's creation boundary also preserves their path history,
  // even when unrelated schema edits are newer than this change.
  const creation = (await git(["log", "--reverse", "--format=%H", request.commitSha, "--", changeRoot])).trim().split("\n")[0];
  const boundaries = [...new Set([sourceCommit, creation].filter((value): value is string => Boolean(value)))];
  const depths = await Promise.all(boundaries.map(async (sha) => Number((await git(["rev-list", "--count", request.commitSha, "^" + sha])).trim()) + 2));
  const historyDepth = Math.max(...depths);
  if (!Number.isSafeInteger(historyDepth) || historyDepth < 2 || historyDepth > 2_147_483_647) throw conflict("Invalid source history", { code: "source_history_missing" });
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-spec-copy-")));
  try {
    const snapshot = path.join(temporary, "repository");
    // Shared objects are read-only alternates, never writable hardlinks. The
    // temporary checkout contains committed files, not host runtime secrets.
    await git(["clone", "--quiet", "--shared", "--no-checkout", "--", cwd, snapshot]);
    await git(["remote", "set-url", "origin", remoteUrl], snapshot);
    await git(["checkout", "--quiet", "-B", request.branch, request.commitSha], snapshot);
    await unchanged();
    const result = await use(snapshot, historyDepth);
    // A successful Apply is followed by a durable remote receipt and guarded
    // source-specific restoration. Preserve that receipt if the host changed.
    if (request.mode !== "apply") await unchanged();
    return result;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

/** Reuse the adapter's command-based inbound Git/file transport for both SSH
 * and sandbox runners. Its general outbound restore is deliberately unused:
 * source writes restore the pinned candidate under their own index/ref guard. */
export async function stageWorkspaceProgramCopy(input: {
  cwd: string; request: unknown; remoteDirectory: string; leaseId: string; provider: string | null; deadline: number;
  runner: CommandManagedRuntimeRunner; ready(directory: string): Promise<void>;
  execute(directory: string): Promise<WorkspaceProgramExecution>;
}): Promise<WorkspaceProgramExecution> {
  return withWorkspaceProgramCopy(input.cwd, input.request, input.deadline, async (snapshot, historyDepth) => {
    const remaining = input.deadline - Date.now();
    if (remaining < 1000) throw conflict("Workspace staging deadline expired", { code: "workspace_environment_unavailable" });
    const staged = await prepareCommandManagedRuntime({ runner: input.runner, adapterKey: "workspace-openspec", workspaceLocalDir: snapshot,
      workspaceRemoteDir: input.remoteDirectory, syncWorkspace: true, gitHistoryDepth: historyDepth,
      spec: { remoteCwd: input.remoteDirectory, leaseId: input.leaseId, providerKey: input.provider, shellCommand: "sh", timeoutMs: remaining } });
    if (staged.workspaceRemoteDir !== input.remoteDirectory) throw conflict("Workspace staging changed its directory", { code: "workspace_mismatch" });
    await input.ready(staged.workspaceRemoteDir);
    const execution = await input.execute(staged.workspaceRemoteDir);
    return { ...execution, copyRestoreCwd: input.cwd };
  });
}
