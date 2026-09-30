import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalRevisionInspection, sameWorkspaceRepository, workspaceRevisionRequestSchema } from "../services/workspace-revision-inspection.js";

const originalPath = process.env.PATH ?? "";
const gitBinary = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
let cliAvailable = true;
try { execFileSync("openspec", ["--version"], { stdio: "ignore" }); } catch { cliAvailable = false; }
const suite = cliAvailable ? describe : describe.skip;
if (!cliAvailable) console.warn("Workspace CLI inspection tests need the installed OpenSpec CLI");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe("bounded workspace inspection input", () => {
  it("accepts equivalent browser metadata for the canonical repository identity", () => {
    const repository = "git@github.com:fixture/spec.git";
    expect(sameWorkspaceRepository("https://github.com/fixture/spec", repository)).toBe(true);
    expect(sameWorkspaceRepository(repository, repository)).toBe(true);
    for (const value of [null, "https://github.com/other/spec.git", "https://github.com/fixture/spec.git?ref=other",
      "https://user:token@github.com/fixture/spec.git", "https://github.com.evil.test/fixture/spec.git"]) expect(sameWorkspaceRepository(value, repository)).toBe(false);
  });
  it("does not accept commands, paths, mutable Git expressions, or noncanonical repository identities", () => {
    const input = { caseId: randomUUID(), expectedVersion: 1, expectedTurn: 0, commitSha: "a".repeat(40),
      repositorySsh: "git@github.com:fixture/spec.git", branch: "openspec/test", changeId: "test-spec" };
    expect(workspaceRevisionRequestSchema.safeParse(input).success).toBe(true);
    for (const patch of [{ commitSha: "HEAD" }, { repositorySsh: "https://github.com/fixture/spec.git" }, { cwd: "/tmp" },
      { command: "sh" }, { changeId: "../../escape" }]) expect(workspaceRevisionRequestSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
});

suite("committed Git and native OpenSpec inspection", () => {
  let root: string, repo: string, bin: string, baseline: string;
  const change = "fixture-change", branch = "openspec/fixture-change", remote = "git@github.com:fixture/spec.git";
  const changeRoot = "openspec/changes/" + change;
  let model: { templateVersion: string; changeId: string; metadata: { branch: string; sha: string; shaDirty: boolean };
    sources: Array<{ path: string; text: string; sha256: string }> };
  const git = (...args: string[]) => execFileSync(gitBinary, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await fs.writeFile(path.join(repo, file), text); };
  const deck = () => '<!doctype html><script id="review-data" type="application/json">' + JSON.stringify(model) + "</script>";
  const commit = () => { git("add", "."); git("commit", "-qm", "Fixture revision"); return git("rev-parse", "HEAD"); };
  const input = () => ({ caseId: randomUUID(), expectedVersion: 1, expectedTurn: 0, commitSha: git("rev-parse", "HEAD"),
    repositorySsh: remote, branch, changeId: change });
  const inspect = async (override = {}) => JSON.parse((await runLocalRevisionInspection(repo, { ...input(), ...override })).stdout);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-inspection-test-")); repo = path.join(root, "repo"); bin = path.join(root, "bin");
    await fs.mkdir(repo); await fs.mkdir(bin);
    git("init", "-q", "-b", branch); git("config", "user.name", "Inspection Test"); git("config", "user.email", "inspection@example.invalid");
    git("remote", "add", "origin", remote);
    // Only the network query is simulated. Git objects, commits, schema loading,
    // and strict OpenSpec validation run against real files and installed tools.
    await fs.writeFile(path.join(bin, "git"), "#!/usr/bin/env node\n" +
      "const cp=require('node:child_process');const args=process.argv.slice(2);" +
      "if(args.includes('ls-remote')){" +
      "if(!args.includes(process.env.INSPECTION_TEST_REMOTE_URL||" + JSON.stringify(remote) + "))process.exit(12);" +
      "const sha=process.env.INSPECTION_TEST_REMOTE_SHA||cp.execFileSync(" + JSON.stringify(gitBinary) + ",[\"rev-parse\",\"HEAD\"],{encoding:'utf8'}).trim();" +
      "process.stdout.write(sha+'\\trefs/heads/" + branch + "\\n');}else{" +
      "const r=cp.spawnSync(" + JSON.stringify(gitBinary) + ",args,{stdio:'inherit'});process.exit(r.status??1);}", { mode: 0o700 });
    const schemaRoot = "openspec/schemas/factory-pipeline-v2";
    const artifacts = [["proposal", "proposal.md"], ["specs", "specs/**/*.md"], ["tasks", "tasks.md"], ["review-deck", "review-deck.html"]];
    const schema = "name: factory-pipeline-v2\nversion: 1\ndescription: Inspection fixture\nartifacts:\n" + artifacts.map(([id, generates], index) =>
      "  - id: " + id + "\n    generates: " + generates + "\n    description: Fixture\n    template: " + id + ".md\n    instruction: Author the fixture\n    requires: [" + (index ? artifacts[index - 1]![0] : "") + "]\n").join("") +
      "apply:\n  requires: [proposal, specs, tasks, review-deck]\n  tracks: tasks.md\n  instruction: Implement the approved fixture\n";
    const contents: Record<string, string> = {
      "proposal.md": "## Why\nTest source inspection.\n\n## What Changes\n- Add a safe review.\n\n## Capabilities\n### New Capabilities\n- `review`: operator review.\n### Modified Capabilities\nNone.\n\n## Impact\nThe review interface.\n",
      "specs/review/spec.md": "## ADDED Requirements\n\n### Requirement: Operator approval\nThe system SHALL require operator approval.\n\n#### Scenario: Approval\n- **WHEN** the operator approves\n- **THEN** the proposal becomes approved\n",
      "tasks.md": "## 1. Implement\n- [ ] 1.1 Require approval\n",
      "../../schemas/factory-pipeline-v2/schema.yaml": schema,
      ".openspec.yaml": "schema: factory-pipeline-v2\ncreated: 2026-09-28\n",
    };
    for (const [id] of artifacts) contents["../../schemas/factory-pipeline-v2/templates/" + id + ".md"] = "Fixture template\n";
    for (const [file, text] of Object.entries(contents)) await write(path.posix.normalize(changeRoot + "/" + file), text);
    await write(changeRoot + "/.openspec.yaml", "schema: factory-pipeline-v2\ncreated: 2026-09-28\n");
    await write(changeRoot + "/rollout.md", "Supplementary rollout notes are not a schema artifact.\n");
    const sourceSha = commit();
    model = { templateVersion: "review-deck/v2", changeId: change, metadata: { branch, sha: sourceSha, shaDirty: false },
      sources: Object.entries(contents).map(([file, text]) => ({ path: file, text, sha256: hash(text) })) };
    await write(changeRoot + "/review-deck.html", deck()); baseline = commit();
  }, 30_000);
  beforeEach(() => {
    git("reset", "--hard", baseline); git("clean", "-fd"); git("remote", "set-url", "origin", remote);
    vi.stubEnv("PATH", bin + path.delimiter + originalPath);
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it.each(["https://github.com/fixture/spec.git", "https://github.com/fixture/spec"])("uses the existing HTTPS origin %s", async (url) => {
    git("remote", "set-url", "origin", url); vi.stubEnv("INSPECTION_TEST_REMOTE_URL", url);
    expect(await inspect()).toMatchObject({ ok: true, result: { commitSha: baseline, remoteCommitSha: baseline } });
    expect(git("config", "--get", "remote.origin.url")).toBe(url);
  });
  it.each(["https://github.com/other/spec.git", "https://user:token@github.com/fixture/spec.git", "https://github.com/fixture/spec.git?ref=other", "https://github.com.evil.test/fixture/spec.git"])("rejects mismatched or credentialed origin %s", async (url) => {
    git("remote", "set-url", "origin", url);
    expect(await inspect()).toMatchObject({ ok: false, code: "repository_mismatch" });
  });
  it.each(["credential.helper", "http.proxy", "http.sslVerify", "core.askpass"])("rejects repository-owned authentication setting %s", async (key) => {
    const url = "https://github.com/fixture/spec.git";
    git("remote", "set-url", "origin", url); vi.stubEnv("INSPECTION_TEST_REMOTE_URL", url);
    git("config", "--local", key, "untrusted");
    try { expect(await inspect()).toMatchObject({ ok: false, code: "git_transport_override" }); }
    finally { git("config", "--local", "--unset-all", key); }
  });
  it("returns immutable blob bytes, the source commit, and actual CLI validation", async () => {
    const result = await inspect();
    expect(result).toMatchObject({ ok: true, result: { commitSha: baseline, remoteCommitSha: baseline,
      inputCommitSha: model.metadata.sha, cli: { status: { isComplete: true, schemaName: "factory-pipeline-v2" },
        validation: { summary: { totals: { failed: 0, passed: 1 } } } } } });
    expect(result.result.files.find((file: { path: string }) => file.path === changeRoot + "/proposal.md").sha256).toBe(hash(model.sources[0]!.text));
    expect(result.result.cli.artifacts.map((artifact: { id: string; dependsOn: string[] }) => ({ id: artifact.id, dependsOn: artifact.dependsOn })))
      .toEqual([{ id: "proposal", dependsOn: [] }, { id: "specs", dependsOn: ["proposal"] }, { id: "tasks", dependsOn: ["specs"] }, { id: "review-deck", dependsOn: ["tasks"] }]);
    expect(result.result.cli.artifacts.every((artifact: { inputDigest: string; outputDigest: string }) => /^[a-f0-9]{64}$/.test(artifact.inputDigest)
      && /^[a-f0-9]{64}$/.test(artifact.outputDigest))).toBe(true);
  });
  it("changes transitive input digests when upstream source changes but downstream files stay present", async () => {
    const first = (await inspect()).result;
    const changed = structuredClone(model), source = changed.sources.find((file) => file.path === "proposal.md")!;
    source.text += "\nAdditional motivation.\n"; source.sha256 = hash(source.text);
    await write(changeRoot + "/proposal.md", source.text);
    changed.metadata.sha = commit();
    await write(changeRoot + "/review-deck.html", '<!doctype html><script id="review-data" type="application/json">' + JSON.stringify(changed) + "</script>");
    commit();
    const next = (await inspect()).result;
    for (const id of ["specs", "tasks"]) {
      const before = first.cli.artifacts.find((a: { id: string }) => a.id === id), after = next.cli.artifacts.find((a: { id: string }) => a.id === id);
      expect(after.outputDigest).toBe(before.outputDigest);
      expect(after.inputDigest).not.toBe(before.inputDigest);
    }
  });
  it("includes deleted template inputs when identifying the source commit", async () => {
    const extra = "openspec/schemas/factory-pipeline-v2/templates/optional.json";
    await write(extra, '{"optional":true}\n'); commit();
    await fs.unlink(path.join(repo, extra)); const deletion = commit();
    const changed = structuredClone(model); changed.metadata.sha = deletion;
    await write(changeRoot + "/review-deck.html", '<!doctype html><script id="review-data" type="application/json">' + JSON.stringify(changed) + "</script>"); commit();
    expect(await inspect()).toMatchObject({ ok: true, result: { inputCommitSha: deletion } });
  });
  it("rejects a dirty workspace and a moved remote branch", async () => {
    await write("unexpected.txt", "Uncommitted work");
    expect(await inspect()).toMatchObject({ ok: false, code: "workspace_dirty" });
    await fs.unlink(path.join(repo, "unexpected.txt")); vi.stubEnv("INSPECTION_TEST_REMOTE_SHA", "b".repeat(40));
    expect(await inspect()).toMatchObject({ ok: false, code: "remote_revision_conflict" });
  });
  it("rejects wrong repository, branch, or expected commit", async () => {
    expect(await inspect({ repositorySsh: "git@github.com:someone/else.git" })).toMatchObject({ ok: false, code: "repository_mismatch" });
    expect(await inspect({ branch: "openspec/other" })).toMatchObject({ ok: false, code: "branch_mismatch" });
    expect(await inspect({ commitSha: "f".repeat(40) })).toMatchObject({ ok: false, code: "revision_conflict" });
  });
  it("inspects canonical source but blocks readiness for a deck that invents bytes", async () => {
    const forged = structuredClone(model); forged.sources[0]!.text += "Invented change"; forged.sources[0]!.sha256 = hash(forged.sources[0]!.text);
    await write(changeRoot + "/review-deck.html", '<script id="review-data" type="application/json">' + JSON.stringify(forged) + "</script>"); commit();
    expect(await inspect()).toMatchObject({ ok: true, result: { cli: { readiness: { state: "draft", deck: "invalid", reasons: ["source_bytes_mismatch"] } } } });
  });
  it("rejects omitted canonical sources and symlink artifacts", async () => {
    const forged = structuredClone(model); forged.sources = forged.sources.filter((file) => file.path !== "tasks.md");
    await write(changeRoot + "/review-deck.html", '<script id="review-data" type="application/json">' + JSON.stringify(forged) + "</script>"); commit();
    expect(await inspect()).toMatchObject({ ok: true, result: { cli: { readiness: { state: "draft", deck: "invalid", reasons: ["review_source_omitted"] } } } });
    git("reset", "--hard", baseline); await fs.unlink(path.join(repo, changeRoot, "tasks.md"));
    await fs.symlink("../../outside.md", path.join(repo, changeRoot, "tasks.md")); commit();
    expect(await inspect()).toMatchObject({ ok: false, code: "source_missing_or_symlink" });
  });
  it("rejects Git transport rewrites before a network operation", async () => {
    git("config", "url.https://github.com/.insteadOf", "git@github.com:");
    try { expect(await inspect()).toMatchObject({ ok: false, code: "git_transport_override" }); }
    finally { git("config", "--remove-section", "url.https://github.com/"); }
  });
  it("rejects a repository SSH command before it can execute", async () => {
    const marker = path.join(repo, ".git/ssh-override-ran");
    git("config", "core.sshCommand", "sh -c 'touch .git/ssh-override-ran; exit 1' --");
    // Use real Git, including its transport selection. The hostile command
    // writes only a marker and exits, so this test never contacts the network.
    vi.stubEnv("PATH", originalPath);
    try {
      const result = await inspect();
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result).toMatchObject({ ok: false, code: "git_transport_override" });
    } finally {
      git("config", "--unset", "core.sshCommand");
      await fs.rm(marker, { force: true });
    }
  });
  it("rejects invalid UTF-8 instead of hashing replacement characters as source", async () => {
    await fs.writeFile(path.join(repo, changeRoot, "proposal.md"), Buffer.from([0xf0, 0x90, 0x80])); commit();
    expect(await inspect()).toMatchObject({ ok: false, code: "source_not_utf8_text" });
  });
  it("inspects a factory draft before its required review deck exists", async () => {
    await fs.unlink(path.join(repo, changeRoot, "review-deck.html")); commit();
    const response = await inspect();
    expect(response).toMatchObject({ ok: true, result: { cli: { status: { isComplete: false },
      readiness: { state: "draft", deck: "missing", reasons: ["artifacts_incomplete", "review_deck_missing"] } } } });
    expect(response.result.cli.artifacts.find((a: { id: string }) => a.id === "review-deck")).toMatchObject({ files: [], dependsOn: ["tasks"] });
    expect(response.result.files.some((file: { path: string }) => file.path.endsWith("/proposal.md"))).toBe(true);
  });
  it("uses the actual standard schema for a new empty change, preserving CLI diagnostics", async () => {
    await fs.rm(path.join(repo, changeRoot), { recursive: true });
    execFileSync("openspec", ["new", "change", change, "--schema", "spec-driven"], { cwd: repo, stdio: "pipe" });
    const sha = commit();
    const response = await inspect();
    expect(response).toMatchObject({ ok: true, result: { inputCommitSha: sha, cli: { status: { schemaName: "spec-driven", isComplete: false },
      readiness: { state: "draft", deck: "not_required", reasons: ["artifacts_incomplete", "openspec_validation_failed"] } } } });
    expect(response.result.cli.artifacts).toHaveLength(4);
    expect(response.result.cli.artifacts.every((a: { files: unknown[] }) => a.files.length === 0)).toBe(true);
    expect(response.result.cli.artifacts.find((a: { id: string }) => a.id === "tasks").dependsOn).toEqual(["design", "specs"]);
    expect(response.result.cli.validation.items[0].issues[0].message).toContain("at least one delta");
    expect(response.result.files).toHaveLength(1);
  });
  it("permits complete valid standard-schema source without inventing a deck requirement", async () => {
    await write(changeRoot + "/.openspec.yaml", "schema: spec-driven\ncreated: 2026-09-28\n");
    await write(changeRoot + "/design.md", "## Context\nAn operator needs to review source.\n");
    await fs.unlink(path.join(repo, changeRoot, "review-deck.html")); const sha = commit();
    const response = await inspect();
    expect(response).toMatchObject({ ok: true, result: { inputCommitSha: sha, cli: { status: { schemaName: "spec-driven", isComplete: true },
      readiness: { state: "ready", deck: "not_required", reasons: [] } } } });
    expect(response.result.cli.artifacts).toHaveLength(4);
    expect(response.result.files.some((file: { path: string }) => file.path.includes("factory-pipeline-v2"))).toBe(false);
  });
  it("keeps file presence separate from invalid Markdown", async () => {
    await write(changeRoot + "/.openspec.yaml", "schema: spec-driven\ncreated: 2026-09-28\n");
    await write(changeRoot + "/design.md", "## Context\nDraft design.\n");
    await write(changeRoot + "/specs/review/spec.md", "## ADDED Requirements\n\n### Requirement: Operator approval\nApproval is a draft without a scenario.\n");
    commit();
    expect(await inspect()).toMatchObject({ ok: true, result: { cli: { status: { isComplete: true },
      readiness: { state: "draft", reasons: ["openspec_validation_failed"] }, validation: { items: [{ valid: false }] } } } });
  });
});
