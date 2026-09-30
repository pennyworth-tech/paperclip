import type { PluginWorkspaceRevisionRequest } from "@paperclipai/plugin-sdk";
import { sameWorkspaceRepository } from "./workspace-repository.js";

/** Credential-free preflight, serialized into the authoritative workspace. */
export function readWorkspaceRevisionOrigin(input: PluginWorkspaceRevisionRequest, matches: typeof sameWorkspaceRepository, checkRevision = true) {
  const fs = require("node:fs") as typeof import("node:fs");
  const cp = require("node:child_process") as typeof import("node:child_process");
  const fail = (code: string): never => { throw new Error(code); };
  const git = (args: string[], optional = false) => {
    const result = cp.spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: process.cwd(), env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (result.error || (result.status !== 0 && !(optional && result.status === 1))) fail("git_inspection_failed");
    return result.stdout;
  };
  if (!/^[a-f0-9]{40}$/.test(input.commitSha) || !matches(input.repositorySsh, input.repositorySsh)
    || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(input.changeId) || !input.branch || input.branch.startsWith("-")) fail("invalid_inspection_input");
  git(["check-ref-format", "refs/heads/" + input.branch]);
  if (fs.realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== fs.realpathSync(process.cwd())) fail("workspace_root_mismatch");
  if (git(["symbolic-ref", "--short", "HEAD"]).trim() !== input.branch) fail("branch_mismatch");
  if (checkRevision && git(["rev-parse", "HEAD"]).trim() !== input.commitSha) fail("revision_conflict");
  const remoteUrl = git(["config", "--get", "remote.origin.url"]).trim();
  if (!matches(remoteUrl, input.repositorySsh)) fail("repository_mismatch");
  // Before status or checkout: repository-owned filters can execute during them.
  const localConfig = git(["config", "--show-scope", "--get-regexp", "^(credential\\..*|http\\..*|core\\.askpass|filter\\..*\\.(clean|process))$"], true);
  if (localConfig.split(/\r?\n/).some((line) => /^(local|worktree)\s/.test(line))) fail("git_transport_override");
  if (git(["config", "--get-regexp", "^(core\\.sshcommand|url\\..*\\.(insteadof|pushinsteadof)|remote\\.origin\\.(proxy|pushurl))$"], true).trim()) fail("git_transport_override");
  return remoteUrl;
}

export const workspaceRevisionOriginProgram = "const __name=(fn,name)=>Object.defineProperty(fn,'name',{value:name,configurable:true}); "
  + "try { const remoteUrl=(" + readWorkspaceRevisionOrigin.toString() + ")(JSON.parse(require('node:fs').readFileSync(0,'utf8')), "
  + sameWorkspaceRepository.toString() + "); process.stdout.write(JSON.stringify({ok:true,remoteUrl})); } "
  + "catch(error) { process.stdout.write(JSON.stringify({ok:false,code:/^[a-z][a-z0-9_]*$/.test(error.message)?error.message:'source_inspection_failed'})); process.exitCode=1; }";
