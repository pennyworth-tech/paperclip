import type { PluginWorkspaceRevisionRequest } from "@paperclipai/plugin-sdk";
import { inspectOpenSpecTree } from "./workspace-openspec-tree.js";

/** Serialized and executed inside the resolved workspace environment, never in the plugin. */
function inspectCommittedOpenSpec(input: PluginWorkspaceRevisionRequest, inspectTree: typeof inspectOpenSpecTree) {
  const fs = require("node:fs") as typeof import("node:fs");
  const cp = require("node:child_process") as typeof import("node:child_process");
  const maxBytes = 8 * 1024 * 1024;
  const fail = (code: string): never => { throw new Error(code); };
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" };
  // A repository-local executable or shell string is never accepted as an inspection command.
  const run = (command: string, args: string[], cwd = process.cwd(), optional = false, diagnostic = false) => {
    const result = cp.spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 45_000, maxBuffer: maxBytes, windowsHide: true });
    if (result.error || (result.status !== 0 && !optional && !(diagnostic && result.status === 1))) fail(command === "git" ? "git_inspection_failed" : "openspec_validation_failed");
    return result.status === 0 || diagnostic ? result.stdout : "";
  };
  const git = (args: string[], optional = false) => run("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], process.cwd(), optional);
  try {
    if (!/^[a-f0-9]{40}$/.test(input.commitSha) || !/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.repositorySsh)
      || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(input.changeId) || !input.branch || input.branch.startsWith("-")) fail("invalid_inspection_input");
    git(["check-ref-format", "refs/heads/" + input.branch]);
    if (fs.realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== fs.realpathSync(process.cwd())) fail("workspace_root_mismatch");
    if (git(["symbolic-ref", "--short", "HEAD"]).trim() !== input.branch) fail("branch_mismatch");
    if (git(["rev-parse", "HEAD"]).trim() !== input.commitSha) fail("revision_conflict");
    if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) fail("workspace_dirty");
    const remoteUrl = git(["config", "--get", "remote.origin.url"]).trim();
    const httpsUrl = input.repositorySsh.replace(/^git@github\.com:/, "https://github.com/");
    if (![input.repositorySsh, httpsUrl, httpsUrl.replace(/\.git$/, "")].includes(remoteUrl)) fail("repository_mismatch");
    // HTTPS uses the runner's configured credential helper. Repository-owned
    // helper or HTTP settings must not intercept its runtime credentials.
    const localAuth = git(["config", "--show-scope", "--get-regexp", "^(credential\\..*|http\\..*|core\\.askpass)$"], true);
    if (localAuth.split(/\r?\n/).some((line) => /^(local|worktree)\s/.test(line))) fail("git_transport_override");
    // Reject repository shell commands, rewrites, and proxies before Git can
    // replace the verified remote or execute a repository-owned command.
    if (git(["config", "--get-regexp", "^(core\\.sshcommand|url\\..*\\.(insteadof|pushinsteadof)|remote\\.origin\\.(proxy|pushurl))$"], true).trim()) fail("git_transport_override");
    const remoteLine = git(["ls-remote", "--exit-code", remoteUrl, "refs/heads/" + input.branch]).trim().split(/\r?\n/);
    if (remoteLine.length !== 1 || remoteLine[0] !== input.commitSha + "\trefs/heads/" + input.branch) fail("remote_revision_conflict");
    const snapshot = inspectTree(input, process.cwd());
    if (git(["rev-parse", "HEAD"]).trim() !== input.commitSha || git(["symbolic-ref", "--short", "HEAD"]).trim() !== input.branch
      || git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) fail("workspace_changed_during_inspection");
    const result = { commitSha: input.commitSha, inputCommitSha: snapshot.inputCommitSha, repositorySsh: input.repositorySsh, branch: input.branch,
      changeId: input.changeId, remoteCommitSha: input.commitSha, files: snapshot.files, cli: snapshot.cli };
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail("snapshot_size_limit");
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : "source_inspection_failed";
    process.stdout.write(JSON.stringify({ ok: false, code })); process.exitCode = 1;
  }
}

// esbuild's keepNames transform can reference its name helper inside serialized
// functions. Provide the same harmless helper when the server is bundled.
export const workspaceRevisionInspectionProgram = "const __name=(fn,name)=>Object.defineProperty(fn,'name',{value:name,configurable:true}); ("
  + inspectCommittedOpenSpec.toString() + ")(JSON.parse(require('node:fs').readFileSync(0,'utf8')), "
  + inspectOpenSpecTree.toString() + ")";
