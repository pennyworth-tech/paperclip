import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginWorkspaceEditRequest } from "@paperclipai/plugin-sdk";
import { workspaceSourceEditProgram } from "../services/workspace-source-edit-program.js";
import { workspaceRevisionInspectionProgram } from "../services/workspace-revision-inspection-program.js";
import { runDurableSourceEdit, type SourceEditCheckpoint, type SourceEditProgramInput, type WorkspaceProgramExecution } from "../services/workspace-source-edit-recovery.js";
import { stageWorkspaceProgramCopy, withWorkspaceProgramCopy } from "../services/workspace-program-copy.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { workspaceEditAbortSchema, workspaceEditRequestSchema } from "../services/workspace-source-edit.js";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { workspaceSourceEditOriginProgram } from "../services/workspace-source-edit-auth.js";

const originalPath = process.env.PATH ?? "";
const gitBinary = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
let cliAvailable = true;
try { execFileSync("openspec", ["--version"], { stdio: "ignore" }); } catch { cliAvailable = false; }
const suite = cliAvailable ? describe : describe.skip;
if (!cliAvailable) console.warn("Workspace source edit tests need the installed OpenSpec CLI");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("source edit request boundary", () => {
  it("accepts bounded Markdown edits while rejecting executable controls and ambiguous files", () => {
    const value = { caseId: randomUUID(), expectedVersion: 1, expectedTurn: 0, operationId: randomUUID(),
      commitSha: "a".repeat(40), repositorySsh: "git@github.com:fixture/spec.git", branch: "openspec/fixture-change", changeId: "fixture-change",
      mode: "preview", actorUserId: "fixture-user", reason: "Clarify source", files: [{ path: "proposal.md", baseSha256: null, text: "New source" }] };
    expect(workspaceEditRequestSchema.safeParse(value).success).toBe(true);
    for (const patch of [{ command: "sh" }, { cwd: "/tmp" }, { mode: "abort" }, { mode: "prepare" }, { mode: "restore" }, { publication: {} }, { recovery: {} }, { actorUserId: "another\nuser" },
      { operationId: "------------------------------------" }, { files: [...value.files, ...value.files] },
      { files: [{ path: "design.md", baseSha256: null, text: "Invalid \ud800 Unicode" }] },
      { files: [{ path: "../outside.md", baseSha256: null, text: "No" }] },
      { files: [{ path: "proposal.md", baseSha256: null, text: null }] },
    ]) expect(workspaceEditRequestSchema.safeParse({ ...value, ...patch }).success).toBe(false);
    const { mode: _mode, ...abort } = value;
    expect(workspaceEditAbortSchema.safeParse(abort).success).toBe(true);
  });
});

// These cases run the CLI's full artifact graph plus multiple real Git recovery
// round trips; the unit-test default of 15 seconds is too short under contention.
suite("confined source editing with real Git and OpenSpec validation", { timeout: 60_000 }, () => {
  let root: string, repo: string, bare: string, bin: string, baseline: string;
  const change = "fixture-change", branch = "openspec/fixture-change", remote = "git@github.com:fixture/spec.git";
  const changeRoot = "openspec/changes/" + change, schemaRoot = "openspec/schemas/factory-pipeline-v2";
  const proposal = "# Fixture source editor\n\n**Spec version:** 1\n\n## Why\nTest edits with an actual CLI.\n\n## What Changes\n- Add operator review.\n\n## Capabilities\n### New Capabilities\n- `review`: source editing.\n### Modified Capabilities\nNone.\n\n## Impact\nThe review interface.\n";
  const git = (...args: string[]) => execFileSync(gitBinary, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remoteHead = () => git("--git-dir=" + bare, "rev-parse", "refs/heads/" + branch);
  const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await fs.writeFile(path.join(repo, file), text); };
  const commit = () => { git("add", "."); git("commit", "-qm", "Fixture revision"); return git("rev-parse", "HEAD"); };
  const input = (patch: Partial<PluginWorkspaceEditRequest> = {}): PluginWorkspaceEditRequest => ({
    caseId: randomUUID(), expectedVersion: 1, expectedTurn: 0, commitSha: baseline,
    repositorySsh: remote, branch, changeId: change, operationId: randomUUID(), mode: "preview", actorUserId: "fixture-user",
    reason: "Clarify the proposal", files: [{ path: "proposal.md", baseSha256: hash(proposal), text: proposal + "\nProposed clarification.\n" }], ...patch,
  });
  const execute = (request: SourceEditProgramInput, cwd = repo) => new Promise<any>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", workspaceSourceEditProgram], { cwd, encoding: "utf8", maxBuffer: 8_000_000, timeout: 60_000 }, (_error, stdout, stderr) => {
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stderr || stdout || "No source edit receipt")); }
    });
    child.stdin?.on("error", () => {}); child.stdin?.end(JSON.stringify(request));
  });
  // Use the real adapter transfer scripts through a local command runner. Host
  // and remote directories are separate; only the environment RPC is simulated.
  const runner: CommandManagedRuntimeRunner = { execute: (request) => new Promise((resolve) => {
    const child = execFile(request.command, request.args ?? [], { cwd: request.cwd ?? "/", env: { ...process.env, ...request.env }, encoding: "utf8",
      timeout: request.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ stdout, stderr,
      exitCode: error ? typeof error.code === "number" ? error.code : null : 0, timedOut: error?.killed === true,
      signal: error?.signal ?? null, pid: child.pid ?? null, startedAt: null }));
    child.stdin?.on("error", () => {}); child.stdin?.end(request.stdin);
  }) };
  const copySession = (publicationEnv?: Record<string, string>) => {
    let checkpoint: SourceEditCheckpoint = {};
    const execute = vi.fn(async (request: SourceEditProgramInput): Promise<WorkspaceProgramExecution> => stageWorkspaceProgramCopy({
      cwd: repo, request, remoteDirectory: path.join(root, "copy-" + randomUUID()), leaseId: randomUUID(), provider: "test-command-runner",
      deadline: Date.now() + 60_000, runner,
      ready: async (cwd) => {
        expect(execFileSync(gitBinary, ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()).toBe(baseline);
        expect(execFileSync(gitBinary, ["rev-parse", "--is-shallow-repository"], { cwd, encoding: "utf8" }).trim()).toBe("true");
        await expect(fs.stat(path.join(cwd, "workspace-secrets.env"))).rejects.toMatchObject({ code: "ENOENT" });
      },
      execute: async (cwd) => {
        if (request.mode === "apply" && publicationEnv) {
          const preflight = await runner.execute({ command: process.execPath, args: ["-e", workspaceSourceEditOriginProgram], cwd, stdin: JSON.stringify(request) });
          expect(JSON.parse(preflight.stdout)).toEqual({ ok: true, remoteUrl: publicationEnv.PAPERCLIP_WORKSPACE_EDIT_ORIGIN });
        }
        return runner.execute({ command: process.execPath, args: ["-e", workspaceSourceEditProgram], cwd, stdin: JSON.stringify(request),
          env: request.mode === "apply" ? publicationEnv : undefined });
      },
    }));
    const restore = vi.fn(async (request: SourceEditProgramInput, cwd: string) => {
      expect(checkpoint.copyPublication?.commitSha).toBe(checkpoint.recovery!.commitSha);
      expect(cwd).toBe(repo);
      return runner.execute({ command: process.execPath, args: ["-e", workspaceSourceEditProgram], cwd, stdin: JSON.stringify(request),
        env: { SOURCE_TEST_NO_NETWORK: "1", SOURCE_TEST_NO_SOURCE_TOOLS: "1" } });
    });
    return { execute, restore, save: async (value: SourceEditCheckpoint) => { checkpoint = structuredClone(value); }, checkpoint: () => structuredClone(checkpoint) };
  };

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-source-edit-test-")));
    repo = path.join(root, "repo"); bare = path.join(root, "remote.git"); bin = path.join(root, "bin");
    await fs.mkdir(repo); await fs.mkdir(bin);
    git("init", "-q", "-b", branch); git("config", "user.name", "Source Edit Test"); git("config", "user.email", "source-edit@example.invalid");
    git("remote", "add", "origin", remote); git("init", "-q", "--bare", bare);
    // Leave older ancestry behind the copy boundary. A candidate that omits
    // .git/shallow must fail publication instead of accidentally passing on a
    // tiny fixture whose entire history fits in the transfer.
    for (let i = 0; i < 4; i++) { await write("unrelated.txt", "Older history " + i); commit(); }
    // Redirect only the expected repository transport. Push rejection, objects, refs, the local
    // index, Markdown parsing, and CLI validation run for real.
    await fs.writeFile(path.join(bin, "git"), "#!/usr/bin/env node\n" +
      "const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);" +
      "const push=args.includes('push'),query=args.includes('ls-remote'),network=push||query;" +
      "if(network&&process.env.SOURCE_TEST_NO_NETWORK)process.exit(79);" +
      "if(network&&process.env.SOURCE_TEST_REQUIRE_AUTH){const credential=cp.spawnSync(" + JSON.stringify(gitBinary) + ",['credential','fill'],{input:'protocol=https\\nhost=github.com\\n\\n',encoding:'utf8'});if(credential.status!==0||!credential.stdout.includes('password=fixture-source-token'))process.exit(78);}" +
      "if(push&&args.some(arg=>arg.startsWith('--force')||arg.startsWith('+')))process.exit(74);" +
      "if(network){const expected=process.env.SOURCE_TEST_ORIGIN||process.env.SOURCE_TEST_INSPECTION_ORIGIN||" + JSON.stringify(remote) + ";if(!args.includes(expected))process.exit(12);args[args.indexOf(expected)]=" + JSON.stringify(bare) + ";}" +
      "if(query&&process.env.SOURCE_TEST_BEFORE_PUSH){fs.writeFileSync(" + JSON.stringify(path.join(repo, "unrelated.txt")) + ",process.env.SOURCE_TEST_BEFORE_PUSH);}" +
      "if(push&&process.env.SOURCE_TEST_PUSH_RACE){const parent=cp.execFileSync(" + JSON.stringify(gitBinary) + ",['rev-parse','HEAD^'],{encoding:'utf8'}).trim();" +
      "cp.execFileSync(" + JSON.stringify(gitBinary) + ",['push'," + JSON.stringify(bare) + ",parent+':refs/heads/" + branch + "'],{stdio:'pipe'});}" +
      "const r=cp.spawnSync(" + JSON.stringify(gitBinary) + ",args,{stdio:process.env.SOURCE_TEST_TRACE?['inherit','pipe','pipe']:'inherit'});" +
      "if(process.env.SOURCE_TEST_TRACE){if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);" +
      "if(r.status!==0)fs.appendFileSync(process.env.SOURCE_TEST_TRACE,JSON.stringify({cwd:process.cwd(),args,status:r.status,stderr:r.stderr?.toString()})+'\\n');}" +
      "if(r.status===0&&args.includes('update-ref')&&process.cwd()===" + JSON.stringify(repo) + "&&process.env.SOURCE_TEST_CRASH_AFTER_REF)process.kill(process.ppid,'SIGKILL');" +
      "if(push&&r.status===0&&process.env.SOURCE_TEST_AFTER_PUSH){" +
      "const target=" + JSON.stringify(path.join(repo, "unrelated.txt")) + ";fs.writeFileSync(target,process.env.SOURCE_TEST_AFTER_PUSH);" +
      "if(process.env.SOURCE_TEST_STAGE)cp.execFileSync(" + JSON.stringify(gitBinary) + ",['add','unrelated.txt'],{cwd:" + JSON.stringify(repo) + "});}" +
      "if(push&&r.status===0&&process.env.SOURCE_TEST_LOST_PUSH)process.exit(73);process.exit(r.status??1);", { mode: 0o700 });
    for (const command of ["openspec", "python3"]) {
      const executable = execFileSync("which", [command], { encoding: "utf8" }).trim();
      await fs.writeFile(path.join(bin, command), "#!/usr/bin/env node\nif(process.env.SOURCE_TEST_NO_SOURCE_TOOLS)process.exit(79);" +
        "if(process.env.SOURCE_TEST_REQUIRE_AUTH&&(process.env.PAPERCLIP_GIT_TOKEN||process.env.GIT_CONFIG_COUNT))process.exit(78);" +
        "const result=require('node:child_process').spawnSync(" + JSON.stringify(executable) + ",process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);", { mode: 0o700 });
    }
    const artifacts = [["research", "research.md"], ["elaboration-proposal", "proposal.md"], ["elaboration-specs", "specs/**/*.md"],
      ["elaboration-design", "design.md"], ["elaboration-tasks", "tasks.md"], ["elaboration-review-deck", "review-deck.html"]];
    const schema = "name: factory-pipeline-v2\nversion: 1\ndescription: Source editing fixture\nartifacts:\n" + artifacts.map(([id, generates], index) =>
      "  - id: " + id + "\n    generates: " + generates + "\n    description: Fixture\n    template: " + id + ".md\n    instruction: Author the fixture\n    requires: [" + artifacts.slice(0, index).map(([name]) => name).join(", ") + "]\n").join("") +
      "apply:\n  requires: [elaboration-review-deck]\n  tracks: tasks.md\n  instruction: Implement the approved fixture\n";
    await write(schemaRoot + "/schema.yaml", schema);
    for (const [id] of artifacts) await write(schemaRoot + "/templates/" + id + ".md", "Fixture template\n");
    await write(schemaRoot + "/templates/review-deck.html", '<!doctype html><html><body><script id="review-data" type="application/json">{}</script></body></html>');
    await write(schemaRoot + "/tools/render_review.py", await fs.readFile(new URL("./fixtures/openspec-source-edit/render_review.py", import.meta.url), "utf8"));
    await write(changeRoot + "/.openspec.yaml", "schema: factory-pipeline-v2\ncreated: 2026-09-28\n");
    await write(changeRoot + "/research.md", "# Research\nUse a single preparation task.\n");
    await write(changeRoot + "/proposal.md", proposal);
    await write(changeRoot + "/specs/review/spec.md", "## ADDED Requirements\n\n### Requirement: Operator approval\nThe system SHALL require operator approval.\n\n**Short title:** Require operator approval\n\n#### Scenario: Approval\n- **WHEN** the operator approves\n- **THEN** the proposal becomes approved\n");
    await write(changeRoot + "/design.md", "# Design\n\n## Review decisions\n\n### D1: Single preparation task\n**Context:** A case can return for corrections.\n**Proposed option:** Reassign the same issue.\n**Pros:**\n- History stays together.\n**Cons:**\n- Handoffs need coordination.\n**Decision needed:** Use one preparation task?\n");
    await write(changeRoot + "/tasks.md", "## M1: Implement\n**Depends on:** none\n**Outcome:** Source editing works.\n\n- [ ] 1.1 Require approval\n  - Type: code\n  - Owner: Author\n  - Depends on: none\n  - Details: Require explicit approval.\n  - Acceptance: Unapproved work is blocked.\n");
    await write("unrelated.txt", "Unrelated baseline\n"); commit();
    execFileSync("python3", ["-I", schemaRoot + "/tools/render_review.py", "--change", change], { cwd: repo, stdio: "pipe", env: { ...process.env, OPENSPEC_TELEMETRY: "0" } });
    baseline = commit(); git("push", "-q", bare, "HEAD:refs/heads/" + branch);
  }, 30_000);
  beforeEach(async () => {
    git("remote", "set-url", "origin", remote);
    git("reset", "--hard", baseline); git("clean", "-fd"); git("--git-dir=" + bare, "update-ref", "refs/heads/" + branch, baseline);
    await fs.rm(path.join(repo, ".git/paperclip-source-edits"), { recursive: true, force: true });
    vi.stubEnv("PATH", bin + path.delimiter + originalPath);
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it.each([remote, "https://github.com/fixture/spec.git", "https://github.com/fixture/spec"])("inspects a staged copy while preserving origin %s", async (url) => {
    git("remote", "set-url", "origin", url); vi.stubEnv("SOURCE_TEST_INSPECTION_ORIGIN", url);
    const result = await stageWorkspaceProgramCopy({ cwd: repo, request: input(),
      remoteDirectory: path.join(root, "inspect-copy-" + randomUUID()), leaseId: randomUUID(), provider: "test-command-runner",
      deadline: Date.now() + 60_000, runner, ready: async (cwd) => {
        expect(execFileSync(gitBinary, ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim()).toBe(url);
      }, execute: async (cwd) => runner.execute({ command: process.execPath, args: ["-e", workspaceRevisionInspectionProgram], cwd, stdin: JSON.stringify(input()) }),
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { commitSha: baseline, remoteCommitSha: baseline } });
    expect(git("config", "--get", "remote.origin.url")).toBe(url); expect(git("rev-parse", "HEAD")).toBe(baseline);
  });
  it.each(["https://github.com/fixture/spec.git", "https://github.com/fixture/spec"])("previews and publishes edits from HTTPS origin %s", async (url) => {
    git("remote", "set-url", "origin", url); vi.stubEnv("SOURCE_TEST_ORIGIN", url);
    const request = input(); expect(await execute(request)).toMatchObject({ ok: true, result: { published: false } });
    const auth = buildGitAuthInvocation({ token: "fixture-source-token", source: "company_secret", secretName: "GITHUB_TOKEN" });
    for (const [key, value] of Object.entries(auth.env)) vi.stubEnv(key, value);
    vi.stubEnv("SOURCE_TEST_REQUIRE_AUTH", "1"); vi.stubEnv("GIT_CONFIG_COUNT", String(auth.configArgs.length / 2));
    for (let i = 0; i < auth.configArgs.length; i += 2) {
      const config = auth.configArgs[i + 1]!, separator = config.indexOf("=");
      vi.stubEnv(`GIT_CONFIG_KEY_${i / 2}`, config.slice(0, separator)); vi.stubEnv(`GIT_CONFIG_VALUE_${i / 2}`, config.slice(separator + 1));
    }
    const result = await execute({ ...request, mode: "apply" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { published: true } });
    expect(remoteHead()).toBe(result.result.commitSha); expect(git("rev-parse", "HEAD")).toBe(result.result.commitSha);
    expect(git("config", "--get", "remote.origin.url")).toBe(url); expect(git("status", "--porcelain")).toBe("");
    expect(JSON.stringify(result)).not.toContain("fixture-source-token");
    expect(await fs.readFile(path.join(repo, ".git/config"), "utf8")).not.toContain("fixture-source-token");
    expect(await fs.readFile(path.join(repo, ".git/paperclip-source-edits", request.operationId, "receipt.json"), "utf8")).not.toContain("fixture-source-token");
  });
  it("publishes a durable HTTPS copy and restores the canonical workspace without credentials or network", async () => {
    const url = "https://github.com/fixture/spec", request = input({ mode: "apply" });
    git("remote", "set-url", "origin", url); vi.stubEnv("SOURCE_TEST_ORIGIN", url); vi.stubEnv("SOURCE_TEST_REQUIRE_AUTH", "1");
    const auth = buildGitAuthInvocation({ token: "fixture-source-token", source: "company_secret", secretName: "GITHUB_TOKEN" });
    const env: Record<string, string> = { ...auth.env, PAPERCLIP_WORKSPACE_EDIT_ORIGIN: url, GIT_CONFIG_COUNT: String(auth.configArgs.length / 2) };
    for (let i = 0; i < auth.configArgs.length; i += 2) {
      const config = auth.configArgs[i + 1]!, separator = config.indexOf("=");
      env[`GIT_CONFIG_KEY_${i / 2}`] = config.slice(0, separator); env[`GIT_CONFIG_VALUE_${i / 2}`] = config.slice(separator + 1);
    }
    const session = copySession(env);
    const result = await runDurableSourceEdit(request, false, {}, session);
    expect(result.exitCode, result.stdout).toBe(0);
    const receipt = JSON.parse(result.stdout).result;
    expect(receipt.published).toBe(true); expect(remoteHead()).toBe(receipt.commitSha); expect(git("rev-parse", "HEAD")).toBe(receipt.commitSha);
    expect(git("config", "--get", "remote.origin.url")).toBe(url); expect(git("status", "--porcelain")).toBe("");
    expect(session.restore).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([session.checkpoint(), receipt])).not.toContain("fixture-source-token");
    vi.stubEnv("SOURCE_TEST_NO_NETWORK", "1"); vi.stubEnv("SOURCE_TEST_NO_SOURCE_TOOLS", "1");
    const resumed = await runDurableSourceEdit(request, false, session.checkpoint(), session);
    expect(resumed.exitCode, resumed.stdout).toBe(0); expect(session.execute).toHaveBeenCalledTimes(2);
  });
  it.each(["https://github.com/other/spec.git", "https://user:token@github.com/fixture/spec.git", "https://github.com/fixture/spec.git?ref=other", "https://github.com.evil.test/fixture/spec.git"])("refuses a copy of mismatched origin %s before transport", async (url) => {
    git("remote", "set-url", "origin", url); const use = vi.fn();
    await expect(withWorkspaceProgramCopy(repo, input(), Date.now() + 60_000, use)).rejects.toMatchObject({ details: { code: "workspace_mismatch" } });
    expect(use).not.toHaveBeenCalled(); expect(git("rev-parse", "HEAD")).toBe(baseline);
  });
  it("rejects unsafe canonical configuration before copy checkout or worktree scanning", async () => {
    const use = vi.fn(); git("config", "filter.fixture.clean", "untrusted");
    try {
      await expect(withWorkspaceProgramCopy(repo, input(), Date.now() + 60_000, use)).rejects.toMatchObject({ details: { code: "git_transport_override" } });
      expect(use).not.toHaveBeenCalled(); expect(git("rev-parse", "HEAD")).toBe(baseline);
    } finally { git("config", "--unset", "filter.fixture.clean"); }
  });

  it("rejects a repository SSH command before editing or publishing", async () => {
    const marker = path.join(repo, ".git/ssh-override-ran");
    git("config", "core.sshCommand", "sh -c 'touch .git/ssh-override-ran; exit 1' --");
    vi.stubEnv("PATH", originalPath);
    try {
      for (const mode of ["preview", "apply"] as const) {
        const result = await execute({ ...input(), mode });
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(result).toMatchObject({ ok: false, code: "git_transport_override" });
      }
      expect(git("rev-parse", "HEAD")).toBe(baseline);
    } finally {
      git("config", "--unset", "core.sshCommand");
      await fs.rm(marker, { force: true });
    }
  });
  it("previews a validated candidate without touching canonical files, index, refs, or remote", async () => {
    const before = await fs.readFile(path.join(repo, ".git/index"));
    const request = input(), result = await execute(request);
    expect(result).toMatchObject({ ok: true, result: { operationId: request.operationId, baseCommitSha: baseline, published: false,
      validation: { passed: true }, changedFiles: [{ path: "proposal.md", beforeSha256: hash(proposal), afterSha256: hash(request.files[0]!.text!) }] } });
    const data = JSON.parse(result.result.deckHtml.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    expect(data.metadata).toMatchObject({ sha: result.result.inputCommitSha, shaDirty: false, branch });
    expect(data.sources.find((source: { path: string }) => source.path === "proposal.md").text).toBe(request.files[0]!.text);
    expect(git("rev-parse", "HEAD")).toBe(baseline); expect(remoteHead()).toBe(baseline);
    expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(before);
    expect(await fs.readFile(path.join(repo, changeRoot, "proposal.md"), "utf8")).toBe(proposal);
  });
  it("applies once, preserves unrelated objects, and replays the same immutable receipt", async () => {
    const request = input({ mode: "apply" }), result = await execute(request);
    expect(result).toMatchObject({ ok: true, result: { published: true } });
    expect(git("rev-parse", "HEAD")).toBe(result.result.commitSha); expect(remoteHead()).toBe(result.result.commitSha);
    expect(git("status", "--porcelain")).toBe(""); expect(git("rev-list", "--count", baseline + "..HEAD")).toBe("2");
    expect(git("show", "HEAD:unrelated.txt")).toBe("Unrelated baseline");
    expect(await execute(request)).toEqual(result);
    expect(await execute({ ...request, reason: "Different request with the same identity" })).toMatchObject({ ok: false, code: "edit_request_conflict" });
  });
  it("prepares a bounded candidate without publication or canonical changes", async () => {
    const request = input(), before = await fs.readFile(path.join(repo, ".git/index"));
    const response = await execute({ ...request, mode: "prepare" });
    expect(response).toMatchObject({ ok: true, result: { prepared: true, recovery: {
      protocol: "openspec-source-candidate/v1", operationId: request.operationId, baseCommitSha: baseline,
    } } });
    const recovery = response.result.recovery;
    expect(Buffer.from(recovery.bundleBase64, "base64").length).toBeLessThanOrEqual(4_000_000);
    expect(git("rev-parse", "HEAD")).toBe(baseline); expect(remoteHead()).toBe(baseline);
    expect(git("status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(before);
    expect((await execute({ ...request, mode: "prepare" })).result.recovery.commitSha).toBe(recovery.commitSha);
  });
  it("resumes the identical candidate in a fresh clone after losing the original push response", async () => {
    const request = input({ mode: "apply" });
    const prepared = await execute({ ...request, mode: "prepare" }); expect(prepared.ok).toBe(true);
    const recovery = prepared.result.recovery;
    const replacement = path.join(root, "replacement-" + randomUUID());
    execFileSync(gitBinary, ["clone", "-q", "--no-hardlinks", "--branch", branch, repo, replacement], { stdio: "pipe" });
    execFileSync(gitBinary, ["remote", "set-url", "origin", remote], { cwd: replacement });
    try {
      vi.stubEnv("SOURCE_TEST_LOST_PUSH", "1");
      expect(await execute({ ...request, recovery })).toMatchObject({ ok: false, code: "git_operation_failed" });
      expect(remoteHead()).toBe(recovery.commitSha);
      // The replacement has no journal, candidate objects, process/index locks,
      // or worktree changes from the workspace that performed the push.
      await expect(fs.stat(path.join(replacement, ".git/paperclip-source-edits"))).rejects.toMatchObject({ code: "ENOENT" });
      vi.stubEnv("SOURCE_TEST_LOST_PUSH", "");
      const resumed = await execute({ ...request, recovery }, replacement);
      expect(resumed, resumed.code).toMatchObject({ ok: true, result: {
        published: true, commitSha: recovery.commitSha, inputCommitSha: recovery.inputCommitSha, sourceDigest: recovery.sourceDigest,
      } });
      expect(execFileSync(gitBinary, ["rev-parse", "HEAD"], { cwd: replacement, encoding: "utf8" }).trim()).toBe(recovery.commitSha);
      expect(execFileSync(gitBinary, ["rev-list", "--count", baseline + "..HEAD"], { cwd: replacement, encoding: "utf8" }).trim()).toBe("2");
      expect(execFileSync(gitBinary, ["status", "--porcelain"], { cwd: replacement, encoding: "utf8" }).trim()).toBe("");
      expect(git("rev-parse", "HEAD")).toBe(baseline);
    } finally { await fs.rm(replacement, { recursive: true, force: true }); }
  });
  it("recovers a prepared candidate after its private Git directory is lost", async () => {
    const request = input({ mode: "apply" }), prepared = await execute({ ...request, mode: "prepare" });
    expect(prepared.ok).toBe(true);
    await fs.rm(path.join(repo, ".git/paperclip-source-edits", request.operationId, "candidate"), { recursive: true });
    const resumed = await execute({ ...request, recovery: prepared.result.recovery });
    expect(resumed, resumed.code).toMatchObject({ ok: true, result: { commitSha: prepared.result.recovery.commitSha } });
    expect(git("status", "--porcelain")).toBe("");
  });
  it("rejects corrupted and differently bound recovery bundles before publishing", async () => {
    const request = input({ mode: "apply" }), prepared = await execute({ ...request, mode: "prepare" }); expect(prepared.ok).toBe(true);
    const recovery = prepared.result.recovery;
    for (const patch of [{ bundleBase64: Buffer.from("corrupted").toString("base64") }, { baseCommitSha: "a".repeat(40) },
      { operationId: randomUUID() }, { requestDigest: "a".repeat(64) }]) {
      expect(await execute({ ...request, recovery: { ...recovery, ...patch } })).toMatchObject({ ok: false, code: "source_edit_recovery_invalid" });
    }
    expect(await execute({ ...request, recovery: { ...recovery, commitSha: "f".repeat(40) } }))
      .toMatchObject({ ok: false, code: "source_edit_recovery_conflict" });
    expect(remoteHead()).toBe(baseline); expect(git("status", "--porcelain")).toBe("");
  });
  it("does not remove another host or PID namespace's workspace writer lock", async () => {
    const lock = path.join(repo, ".git/paperclip-source-edits/writer.lock"); await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 2_000_000_000, processScope: "another-sandbox" }));
    expect(await execute(input({ mode: "apply" }))).toMatchObject({ ok: false, code: "source_writer_unknown" });
    expect(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")).processScope).toBe("another-sandbox");
    expect(remoteHead()).toBe(baseline);
  });
  it("stages both edit phases through the adapter and restores only the verified candidate", async () => {
    await fs.appendFile(path.join(repo, ".git/info/exclude"), "\nworkspace-secrets.env\n");
    await write("workspace-secrets.env", "A host-only fixture, never transferred\n");
    const request = input({ mode: "apply" }), copy = copySession();
    try {
      const execution = await runDurableSourceEdit(request, false, {}, copy), response = JSON.parse(execution.stdout);
      expect(response, response.code).toMatchObject({ ok: true, result: { published: true, commitSha: copy.checkpoint().recovery!.commitSha } });
      expect(copy.execute).toHaveBeenCalledTimes(2); expect(copy.restore).toHaveBeenCalledTimes(1);
      expect(remoteHead()).toBe(git("rev-parse", "HEAD")); expect(git("status", "--porcelain")).toBe("");
      expect(await fs.readFile(path.join(repo, "workspace-secrets.env"), "utf8")).toContain("host-only");
      // A replacement staged after host restoration must still contain the
      // original base, even though the host HEAD is the new candidate now.
      const recovery = copy.checkpoint().recovery!;
      const staged = await copy.execute({ ...request, recovery });
      expect(JSON.parse(staged.stdout), JSON.parse(staged.stdout).code).toMatchObject({ ok: true, result: { commitSha: recovery.commitSha } });
    } finally { await fs.rm(path.join(repo, "workspace-secrets.env"), { force: true }); }
  }, 60_000);
  it("preserves a competing staged edit after remote publication and retries restoration without pushing", async () => {
    const request = input({ mode: "apply" }), copy = copySession();
    vi.stubEnv("SOURCE_TEST_AFTER_PUSH", "Concurrent staged work in the canonical checkout"); vi.stubEnv("SOURCE_TEST_STAGE", "1");
    const failed = await runDurableSourceEdit(request, false, {}, copy);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, code: "workspace_sync_conflict" });
    const published = remoteHead(); expect(published).not.toBe(baseline);
    expect(copy.checkpoint().copyPublication?.commitSha).toBe(published);
    expect(git("rev-parse", "HEAD")).toBe(baseline); expect(git("show", ":unrelated.txt")).toBe("Concurrent staged work in the canonical checkout");
    git("restore", "--source=HEAD", "--staged", "--worktree", "unrelated.txt"); vi.stubEnv("SOURCE_TEST_AFTER_PUSH", "");
    const resumed = await runDurableSourceEdit(request, false, copy.checkpoint(), copy);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, result: { commitSha: published } });
    expect(copy.execute).toHaveBeenCalledTimes(2); expect(copy.restore).toHaveBeenCalledTimes(2);
    expect(git("status", "--porcelain")).toBe("");
  }, 60_000);
  it("recovers interrupted canonical restoration using its saved publication and owned Git lock", async () => {
    const request = input({ mode: "apply" }), copy = copySession(); vi.stubEnv("SOURCE_TEST_CRASH_AFTER_REF", "1");
    const interrupted = await runDurableSourceEdit(request, false, {}, copy);
    expect(interrupted.exitCode).toBeNull(); expect(copy.checkpoint().copyPublication).toBeDefined();
    const published = remoteHead(); expect(git("rev-parse", "HEAD")).toBe(published);
    expect(await fs.readFile(path.join(repo, changeRoot, "proposal.md"), "utf8")).toBe(proposal);
    vi.stubEnv("SOURCE_TEST_CRASH_AFTER_REF", "");
    const resumed = await runDurableSourceEdit(request, false, copy.checkpoint(), copy);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, result: { commitSha: published } });
    expect(copy.execute).toHaveBeenCalledTimes(2); expect(git("status", "--porcelain")).toBe("");
  }, 60_000);
  it("preserves source-history freshness when inspecting a copied review deck", async () => {
    const request = input(), { mode: _, ...revision } = request;
    const execution = await stageWorkspaceProgramCopy({ cwd: repo, request: revision, remoteDirectory: path.join(root, "inspect-copy-" + randomUUID()),
      leaseId: randomUUID(), provider: "test-command-runner", deadline: Date.now() + 60_000, runner,
      ready: async (cwd) => { expect(execFileSync(gitBinary, ["rev-parse", "--is-shallow-repository"], { cwd, encoding: "utf8" }).trim()).toBe("true"); },
      execute: async (cwd) => runner.execute({ command: process.execPath, args: ["-e", workspaceRevisionInspectionProgram], cwd, stdin: JSON.stringify(revision) }),
    });
    const response = JSON.parse(execution.stdout);
    expect(response, response.code).toMatchObject({ ok: true, result: { commitSha: baseline, inputCommitSha: git("rev-parse", baseline + "^") } });
    expect(git("rev-parse", "HEAD")).toBe(baseline); expect(git("status", "--porcelain")).toBe("");
  }, 60_000);
  it("retains standard-schema source ancestry across newer unrelated factory inputs in a copy", async () => {
    await write(changeRoot + "/.openspec.yaml", "schema: spec-driven\ncreated: 2026-09-28\n");
    await fs.unlink(path.join(repo, changeRoot, "review-deck.html"));
    const sourceSha = commit();
    for (let index = 0; index < 3; index++) { await write(schemaRoot + "/templates/unrelated.md", "Other workflow " + index); commit(); }
    const head = git("rev-parse", "HEAD"); git("push", "--quiet", bare, "HEAD:refs/heads/" + branch);
    const request = { ...input(), commitSha: head };
    const execution = await stageWorkspaceProgramCopy({ cwd: repo, request, remoteDirectory: path.join(root, "standard-copy-" + randomUUID()),
      leaseId: randomUUID(), provider: "test-command-runner", deadline: Date.now() + 60_000, runner, ready: async () => {},
      execute: async (cwd) => runner.execute({ command: process.execPath, args: ["-e", workspaceRevisionInspectionProgram], cwd, stdin: JSON.stringify(request) }),
    });
    const response = JSON.parse(execution.stdout);
    expect(response, response.code).toMatchObject({ ok: true, result: { inputCommitSha: sourceSha,
      cli: { status: { schemaName: "spec-driven" }, readiness: { state: "ready", deck: "not_required" } } } });
    expect(git("rev-parse", "HEAD")).toBe(head); expect(git("status", "--porcelain")).toBe("");
  }, 60_000);
  it("recovers a push whose successful response was lost without another commit", async () => {
    const request = input({ mode: "apply" }); vi.stubEnv("SOURCE_TEST_LOST_PUSH", "1");
    expect(await execute(request)).toMatchObject({ ok: false, code: "git_operation_failed" });
    const published = remoteHead(); expect(published).not.toBe(baseline); expect(git("rev-parse", "HEAD")).toBe(baseline);
    vi.stubEnv("SOURCE_TEST_LOST_PUSH", "");
    expect(await execute(request)).toMatchObject({ ok: true, result: { commitSha: published } });
    expect(git("rev-list", "--count", baseline + "..HEAD")).toBe("2");
  });
  it("recovers its own abandoned process and index locks after the local ref moves", async () => {
    const request = input({ mode: "apply" }); vi.stubEnv("SOURCE_TEST_CRASH_AFTER_REF", "1");
    await expect(execute(request)).rejects.toThrow();
    const published = remoteHead(); expect(git("rev-parse", "HEAD")).toBe(published);
    expect(await fs.readFile(path.join(repo, changeRoot, "proposal.md"), "utf8")).toBe(proposal);
    vi.stubEnv("SOURCE_TEST_CRASH_AFTER_REF", "");
    expect(await execute(request)).toMatchObject({ ok: true, result: { commitSha: published } });
    expect(git("status", "--porcelain")).toBe("");
  });
  it("does not remove an index lock owned by another Git operation", async () => {
    await fs.writeFile(path.join(repo, ".git/index.lock"), "Another writer");
    try {
      expect(await execute(input({ mode: "apply" }))).toMatchObject({ ok: false, code: "workspace_index_locked" });
      expect(await fs.readFile(path.join(repo, ".git/index.lock"), "utf8")).toBe("Another writer");
      expect(git("rev-parse", "HEAD")).toBe(baseline);
    } finally { await fs.rm(path.join(repo, ".git/index.lock"), { force: true }); }
  });
  it("refuses a moved remote and a bad base hash without changing either branch", async () => {
    await write("unrelated.txt", "Other actor's commit"); const moved = commit();
    git("push", "-q", bare, "HEAD:refs/heads/" + branch); git("reset", "--hard", baseline);
    expect(await execute(input({ mode: "apply" }))).toMatchObject({ ok: false, code: "remote_revision_conflict" });
    expect(remoteHead()).toBe(moved); expect(git("rev-parse", "HEAD")).toBe(baseline);
    expect(await execute(input({ files: [{ path: "proposal.md", baseSha256: "a".repeat(64), text: "Changed" }] })))
      .toMatchObject({ ok: false, code: "edit_base_conflict" });
  });
  it("previews incomplete Markdown as a draft and still refuses unsupported renderer bytes", async () => {
    expect(await execute(input({ files: [{ path: "proposal.md", baseSha256: hash(proposal), text: "Invalid proposal" }] })))
      .toMatchObject({ ok: true, result: { validation: { passed: false }, deckHtml: "", source: { cli: { readiness: { state: "draft", deck: "missing" }, rendering: { passed: false } } } } });
    await write(schemaRoot + "/tools/render_review.py", "raise RuntimeError('must never execute')\n"); const sha = commit();
    expect(await execute(input({ commitSha: sha }))).toMatchObject({ ok: false, code: "renderer_version_unsupported" });
    expect(remoteHead()).toBe(baseline);
  });
  it("abandons a prepared draft only when publication is conclusively absent", async () => {
    const request = input({ mode: "apply", files: [{ path: "proposal.md", baseSha256: hash(proposal), text: "Invalid proposal" }] });
    const prepared = await execute({ ...request, mode: "prepare" });
    expect(prepared).toMatchObject({ ok: true, result: { prepared: true } });
    expect(prepared.result.recovery.inspection.cli.readiness.state).toBe("draft");
    expect(await execute({ ...request, mode: "abort" })).toMatchObject({ ok: true, result: { operationId: request.operationId, aborted: true } });
    expect(await execute(request)).toMatchObject({ ok: false, code: "edit_aborted" });
    expect(git("rev-parse", "HEAD")).toBe(baseline); expect(remoteHead()).toBe(baseline);
  });
  it("saves an empty standard-schema change without a renderer or a complete specification", async () => {
    await fs.rm(path.join(repo, changeRoot), { recursive: true });
    await fs.rm(path.join(repo, "openspec/schemas"), { recursive: true });
    await write(changeRoot + "/.openspec.yaml", "schema: spec-driven\ncreated: 2026-09-28\n");
    const sha = commit(); git("push", "-q", bare, "HEAD:refs/heads/" + branch);
    const request = input({ mode: "apply", commitSha: sha, files: [{ path: "proposal.md", baseSha256: null, text: "## Why\nA first draft.\n" }] });
    const response = await execute(request);
    expect(response, response.code).toMatchObject({ ok: true, result: { published: true, deckHtml: "", validation: { passed: false },
      source: { cli: { status: { schemaName: "spec-driven", isComplete: false }, readiness: { state: "draft", deck: "not_required" } } } } });
    expect(response.result.source.cli.artifacts).toHaveLength(4);
    expect(git("rev-parse", "HEAD")).toBe(response.result.commitSha); expect(remoteHead()).toBe(response.result.commitSha);
    expect(git("status", "--porcelain")).toBe("");
    expect(await execute(request)).toEqual(response);
  }, 60_000);
  it("preserves failed validation through copied publication and tool-free restoration", async () => {
    const request = input({ mode: "apply", files: [{ path: "proposal.md", baseSha256: hash(proposal), text: "An unfinished proposal.\n" }] });
    const copy = copySession(), response = JSON.parse((await runDurableSourceEdit(request, false, {}, copy)).stdout);
    expect(response, response.code).toMatchObject({ ok: true, result: { published: true, validation: { passed: false }, deckHtml: "",
      source: { cli: { readiness: { state: "draft" }, rendering: { passed: false } } } } });
    expect(copy.checkpoint().recovery!.inspection!.cli).toEqual(response.result.source.cli);
    expect(copy.checkpoint().copyPublication!.inspectionDigest).toBe(response.result.inspectionDigest);
    expect(copy.restore).toHaveBeenCalledTimes(1); expect(copy.execute).toHaveBeenCalledTimes(2);
    await expect(fs.stat(path.join(repo, changeRoot, "review-deck.html"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(git("status", "--porcelain")).toBe("");
    const restored = JSON.parse((await runDurableSourceEdit(request, false, copy.checkpoint(), copy)).stdout);
    expect(restored.result).toEqual(response.result); expect(copy.execute).toHaveBeenCalledTimes(2);
  }, 90_000);
  it("binds draft diagnostics into the candidate and refuses stripped or altered recovery metadata", async () => {
    const request = input({ mode: "apply", files: [{ path: "proposal.md", baseSha256: hash(proposal), text: "Unfinished draft\n" }] });
    const prepared = await execute({ ...request, mode: "prepare" }); expect(prepared.ok).toBe(true);
    const recovery = prepared.result.recovery;
    const stripped = { ...recovery }; delete stripped.inspection; delete stripped.inspectionDigest;
    const altered = structuredClone(recovery); altered.inspection.cli.rendering.message = "Different diagnostics";
    altered.inspectionDigest = hash(JSON.stringify(altered.inspection));
    for (const value of [stripped, altered]) {
      await fs.rm(path.join(repo, ".git/paperclip-source-edits", request.operationId), { recursive: true });
      expect(await execute({ ...request, recovery: value })).toMatchObject({ ok: false, code: "source_edit_recovery_invalid" });
    }
    expect(remoteHead()).toBe(baseline); expect(git("rev-parse", "HEAD")).toBe(baseline);
  }, 60_000);
  it("abandons an unattempted stale local edit without changing another actor's work", async () => {
    const request = input({ mode: "apply" });
    await write("unrelated.txt", "Another actor moved the workspace\n"); const moved = commit();
    expect(await execute(request)).toMatchObject({ ok: false, code: "edit_base_conflict" });
    expect(await execute({ ...request, mode: "abort" })).toMatchObject({ ok: true, result: { aborted: true } });
    expect(await execute(request)).toMatchObject({ ok: false, code: "edit_aborted" });
    expect(git("rev-parse", "HEAD")).toBe(moved); expect(remoteHead()).toBe(baseline);
    expect(git("show", "HEAD:unrelated.txt")).toBe("Another actor moved the workspace");
    expect(git("status", "--porcelain")).toBe("");
  });
  it("abandons its unpushed candidate after a competing remote move", async () => {
    await write("unrelated.txt", "Another actor moved the remote\n"); const moved = commit();
    git("push", "-q", bare, "HEAD:refs/heads/" + branch); git("reset", "--hard", baseline);
    const request = input({ mode: "apply" });
    expect(await execute(request)).toMatchObject({ ok: false, code: "remote_revision_conflict" });
    expect(await execute({ ...request, mode: "abort" })).toMatchObject({ ok: true, result: { aborted: true } });
    expect(remoteHead()).toBe(moved); expect(git("rev-parse", "HEAD")).toBe(baseline);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("does not abandon a successful push merely because its response was lost", async () => {
    const request = input({ mode: "apply" }); vi.stubEnv("SOURCE_TEST_LOST_PUSH", "1");
    expect(await execute(request)).toMatchObject({ ok: false, code: "git_operation_failed" });
    expect(await execute({ ...request, mode: "abort" })).toMatchObject({ ok: false, code: "edit_publication_uncertain" });
    vi.stubEnv("SOURCE_TEST_LOST_PUSH", "");
    expect(await execute(request)).toMatchObject({ ok: true });
    expect(await execute({ ...request, mode: "abort" })).toMatchObject({ ok: false, code: "edit_already_published" });
  });
  it("checks for new workspace edits again immediately before pushing", async () => {
    vi.stubEnv("SOURCE_TEST_BEFORE_PUSH", "Concurrent local draft");
    expect(await execute(input({ mode: "apply" }))).toMatchObject({ ok: false, code: "workspace_dirty" });
    expect(remoteHead()).toBe(baseline);
    expect(await fs.readFile(path.join(repo, "unrelated.txt"), "utf8")).toBe("Concurrent local draft");
  });
  it("uses a remote CAS even when a competing move would allow a fast-forward push", async () => {
    vi.stubEnv("SOURCE_TEST_PUSH_RACE", "1");
    expect(await execute(input({ mode: "apply" }))).toMatchObject({ ok: false, code: "git_operation_failed" });
    expect(remoteHead()).not.toBe(baseline); expect(git("rev-parse", "HEAD")).toBe(baseline);
    expect(git("--git-dir=" + bare, "log", "-1", "--format=%s", "refs/heads/" + branch)).toBe("OpenSpec fixture-change: apply source edit");
  });
  it("adds and removes capability files and regenerates the exact requirement inventory", async () => {
    const oldSpec = await fs.readFile(path.join(repo, changeRoot, "specs/review/spec.md"), "utf8");
    const request = input({ mode: "apply", files: [
      { path: "specs/review/spec.md", baseSha256: hash(oldSpec), text: null },
      { path: "specs/ux-ios-app/spec.md", baseSha256: null, text: oldSpec },
      { path: "proposal.md", baseSha256: hash(proposal), text: proposal.replace("`review`", "`ux-ios-app`") },
    ] });
    const result = await execute(request); expect(result).toMatchObject({ ok: true });
    const data = JSON.parse(result.result.deckHtml.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    expect(data.capabilities.map((cap: { id: string }) => cap.id)).toEqual(["ux-ios-app"]);
    expect(data.counts).toMatchObject({ specifications: 1, requirements: 1, scenarios: 1 });
    expect(git("status", "--porcelain")).toBe("");
  });
  it("pins a deletion-only edit to its new source commit", async () => {
    const spec = await fs.readFile(path.join(repo, changeRoot, "specs/review/spec.md"), "utf8");
    await write(changeRoot + "/specs/optional/spec.md", spec); const sha = commit();
    git("push", "-q", bare, "HEAD:refs/heads/" + branch);
    const result = await execute(input({ mode: "apply", commitSha: sha,
      files: [{ path: "specs/optional/spec.md", baseSha256: hash(spec), text: null }] }));
    expect(result).toMatchObject({ ok: true });
    const data = JSON.parse(result.result.deckHtml.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    expect(data.metadata).toMatchObject({ sha: result.result.inputCommitSha, shaDirty: false });
    expect(data.capabilities.map((cap: { id: string }) => cap.id)).toEqual(["review"]);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("preserves staged concurrent edits after push and resumes only after they are reconciled", async () => {
    const request = input({ mode: "apply" }); vi.stubEnv("SOURCE_TEST_AFTER_PUSH", "Concurrent staged work"); vi.stubEnv("SOURCE_TEST_STAGE", "1");
    expect(await execute(request)).toMatchObject({ ok: false, code: "workspace_sync_conflict" });
    const published = remoteHead(); expect(published).not.toBe(baseline);
    expect(git("show", ":unrelated.txt")).toBe("Concurrent staged work");
    expect(await fs.readFile(path.join(repo, "unrelated.txt"), "utf8")).toBe("Concurrent staged work");
    // The operator resolves their own draft; replay must not force or discard it.
    git("restore", "--source=HEAD", "--staged", "--worktree", "unrelated.txt");
    vi.stubEnv("SOURCE_TEST_AFTER_PUSH", "");
    expect(await execute(request)).toMatchObject({ ok: true, result: { commitSha: published } });
  });
  it("preserves executable input modes and validates the resulting deck", async () => {
    await fs.chmod(path.join(repo, changeRoot, "proposal.md"), 0o755); const sha = commit();
    git("push", "-q", bare, "HEAD:refs/heads/" + branch);
    const result = await execute(input({ mode: "apply", commitSha: sha }));
    expect(result).toMatchObject({ ok: true });
    expect((await fs.stat(path.join(repo, changeRoot, "proposal.md"))).mode & 0o111).toBe(0o111);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("confines edits to Markdown sources and rejects symlink inputs", async () => {
    for (const file of ["../../outside.md", "review-deck.html", ".openspec.yaml", "specs/review/../../outside.md"]) {
      expect(await execute(input({ files: [{ path: file, baseSha256: null, text: "No" }] }))).toMatchObject({ ok: false, code: "invalid_edit_path" });
    }
    await fs.unlink(path.join(repo, changeRoot, "proposal.md")); await fs.symlink("../../../unrelated.txt", path.join(repo, changeRoot, "proposal.md"));
    expect(await execute(input({ commitSha: commit() }))).toMatchObject({ ok: false, code: "source_missing_or_symlink" });
    expect(remoteHead()).toBe(baseline);
  });
});
