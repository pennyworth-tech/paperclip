import type { SourceEditProgramInput, SourceEditRecovery } from "./workspace-source-edit-recovery.js";
import { inspectOpenSpecTree } from "./workspace-openspec-tree.js";
import { readSourceEditInspection, type SourceEditInspection } from "./workspace-source-edit-inspection.js";

/** Host-owned program. No command, executable, arbitrary path, or Git option is supplied by the caller. */
function editOpenSpec(input: SourceEditProgramInput, inspectTree: typeof inspectOpenSpecTree, readInspection: typeof readSourceEditInspection) {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const cp = require("node:child_process") as typeof import("node:child_process");
  // Execute only the reviewed, dependency-free renderer shipped in this release.
  // Python isolated mode prevents imports from the repository or PYTHONPATH.
  const rendererHash = "7585fbb9f5ec0543fc97f46fdf9ebe3fca1bcec42db4861449f3a62129243926";
  const root = process.cwd(), maxBytes = 8 * 1024 * 1024;
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const fail = (code: string, detail?: string): never => { throw Object.assign(new Error(code), { detail }); };
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" };
  const command = (name: string, args: string[], cwd = root, stdin?: string, extraEnv: Record<string, string> = {}) => {
    const result = cp.spawnSync(name, args, { cwd, input: stdin, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 90_000, maxBuffer: maxBytes, windowsHide: true });
    if (result.error || result.status !== 0) fail(name === "git" ? "git_operation_failed" : "edit_validation_failed",
      name === "git" ? undefined : (result.stderr + result.stdout).replaceAll(cwd + "/", "").slice(0, 8000));
    return result.stdout;
  };
  const git = (args: string[], cwd = root, stdin?: string, extraEnv: Record<string, string> = {}) => command("git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd, stdin, extraEnv);
  const schemaRoot = "openspec/schemas/factory-pipeline-v2";
  const editable = (file: string) => /^(?:research|proposal|design|tasks)\.md$/.test(file) || /^specs\/[a-z0-9][a-z0-9-]*\/spec\.md$/.test(file);
  let temporary: string | undefined, lock: string | undefined;
  let indexLock: { path: string; fd: number; dev: number; ino: number } | undefined;
  try {
    if (!["preview", "prepare", "apply", "abort", "restore"].includes(input.mode) || !/^[a-f0-9-]{36}$/.test(input.operationId)
      || !/^[a-f0-9]{40}$/.test(input.commitSha) || !/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.repositorySsh)
      || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(input.changeId) || !input.branch || input.branch.startsWith("-")
      || !input.actorUserId || /\s/.test(input.actorUserId) || input.actorUserId.length > 200 || !input.reason?.trim() || input.reason.length > 2000
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 50 || Buffer.byteLength(JSON.stringify(input.files)) > 4_000_000) fail("invalid_edit_request");
    const seen = new Set<string>();
    for (const file of input.files) {
      if (!file || typeof file.path !== "string" || !editable(file.path) || seen.has(file.path) || (file.baseSha256 !== null && !/^[a-f0-9]{64}$/.test(file.baseSha256))
        || (file.text !== null && (typeof file.text !== "string" || file.text.includes("\0") || Buffer.byteLength(file.text) > 1_000_000))
        || (file.baseSha256 === null && file.text === null)) fail("invalid_edit_path");
      if (file.text !== null && Buffer.from(file.text).toString("utf8") !== file.text) fail("source_not_utf8_text");
      seen.add(file.path);
    }
    git(["check-ref-format", "refs/heads/" + input.branch]);
    if (fs.realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== fs.realpathSync(root)) fail("workspace_root_mismatch");
    if (git(["symbolic-ref", "--short", "HEAD"]).trim() !== input.branch) fail("branch_mismatch");
    if (git(["config", "--get", "remote.origin.url"]).trim() !== input.repositorySsh) fail("repository_mismatch");
    const transport = cp.spawnSync("git", ["config", "--get-regexp", "^(core\\.sshcommand|url\\..*\\.(insteadof|pushinsteadof)|remote\\.origin\\.(proxy|pushurl))$"], { cwd: root, env, encoding: "utf8" });
    if (transport.stdout?.trim()) fail("git_transport_override");
    const requestDigest = hash(JSON.stringify({ operationId: input.operationId, commitSha: input.commitSha,
      repositorySsh: input.repositorySsh, branch: input.branch, changeId: input.changeId,
      actorUserId: input.actorUserId, reason: input.reason, files: input.files }));
    const recovery = input.recovery;
    let bundle: Buffer | undefined;
    if (recovery) {
      if (!["apply", "restore"].includes(input.mode) || recovery.protocol !== "openspec-source-candidate/v1"
        || recovery.operationId !== input.operationId || recovery.baseCommitSha !== input.commitSha || recovery.requestDigest !== requestDigest
        || typeof recovery.createdAt !== "string" || !Number.isFinite(Date.parse(recovery.createdAt))
        || !/^[a-f0-9]{40}$/.test(recovery.commitSha) || !/^[a-f0-9]{40}$/.test(recovery.inputCommitSha)
        || !/^[a-f0-9]{64}$/.test(recovery.sourceDigest) || !/^[a-f0-9]{64}$/.test(recovery.bundleSha256)
        || typeof recovery.bundleBase64 !== "string" || !recovery.bundleBase64.length || recovery.bundleBase64.length > 5_333_336) fail("source_edit_recovery_invalid");
      bundle = Buffer.from(recovery.bundleBase64, "base64");
      if (bundle.length > 4_000_000 || bundle.toString("base64") !== recovery.bundleBase64
        || crypto.createHash("sha256").update(bundle).digest("hex") !== recovery.bundleSha256) fail("source_edit_recovery_invalid");
      if (recovery.inspection || recovery.inspectionDigest) {
        if (readInspection(recovery.inspection, input.changeId, hash).inspectionDigest !== recovery.inspectionDigest) fail("source_edit_recovery_invalid");
      }
    }
    if (input.mode === "restore") {
      const receipt = input.publication;
      if (!recovery || !receipt || fs.realpathSync(receipt.cwd) !== fs.realpathSync(root) || receipt.operationId !== input.operationId || receipt.baseCommitSha !== input.commitSha
        || receipt.commitSha !== recovery.commitSha || receipt.inputCommitSha !== recovery.inputCommitSha || receipt.sourceDigest !== recovery.sourceDigest
        || receipt.inspectionDigest !== recovery.inspectionDigest
        || typeof receipt.cliVersion !== "string" || !receipt.cliVersion || receipt.cliVersion.length > 200) fail("source_copy_receipt_invalid");
    } else if (input.publication) fail("source_copy_receipt_invalid");
    type Journal = { requestDigest: string; createdAt: string; commitSha?: string; inputCommitSha?: string; sourceDigest?: string; pushAttempted?: boolean;
      published?: boolean; synced?: boolean; aborted?: boolean; inspection?: SourceEditInspection; inspectionDigest?: string;
      indexLock?: { dev: number; ino: number; birthtimeMs: number } };
    let journal: Journal, journalPath: string | undefined, candidate: string, restored = false;
    const atomic = (file: string, text: string, mode = 0o600) => {
      const next = file + "." + crypto.randomUUID() + ".tmp";
      try { fs.writeFileSync(next, text, { mode, flag: "wx" }); fs.renameSync(next, file); }
      finally { fs.rmSync(next, { force: true }); }
    };
    const save = () => { if (journalPath) atomic(journalPath, JSON.stringify(journal)); };
    const useCanonicalObjects = (candidate: string) => {
      const objects = path.resolve(root, git(["rev-parse", "--git-path", "objects"]).trim());
      if (/[\r\n]/.test(objects)) fail("workspace_path_unsupported");
      fs.writeFileSync(path.join(candidate, ".git/objects/info/alternates"), objects + "\n");
      // Object alternates do not carry shallow boundaries. Without this file,
      // publication from an adapter-staged clone tries to traverse absent
      // parents of the original source commit and fails during pack creation.
      const shallow = path.resolve(root, git(["rev-parse", "--git-path", "shallow"]).trim());
      const target = path.join(candidate, ".git/shallow");
      if (fs.existsSync(shallow)) {
        if (fs.statSync(shallow).size > 1_000_000) fail("source_size_limit");
        const boundary = fs.readFileSync(shallow, "utf8");
        if (!/^(?:[a-f0-9]{40}\n)+$/.test(boundary)) fail("workspace_shallow_invalid");
        fs.writeFileSync(target, boundary);
      } else fs.rmSync(target, { force: true });
    };
    if (input.mode === "preview") {
      if (git(["rev-parse", "HEAD"]).trim() !== input.commitSha) fail("edit_base_conflict");
      temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spec-preview-"))); candidate = path.join(temporary, "candidate");
      journal = { requestDigest, createdAt: new Date().toISOString() };
    } else {
      const area = path.resolve(root, git(["rev-parse", "--git-path", "paperclip-source-edits"]).trim());
      fs.mkdirSync(area, { recursive: true, mode: 0o700 });
      // A PID only identifies a process within its host/namespace. Never use a
      // different sandbox's process table to declare a shared lock abandoned.
      const processScope = os.hostname() + (process.platform === "linux"
        ? ":" + fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + fs.readlinkSync("/proc/self/ns/pid") : "");
      const lockPath = path.join(area, "writer.lock");
      try { fs.mkdirSync(lockPath, { mode: 0o700 }); lock = lockPath; }
      catch {
        // Serialize abandoned-lock recovery too: two retrying processes must
        // never both remove what one of them has already replaced with a live lock.
        const recoveryLock = path.join(area, "writer-recovery.lock");
        try { fs.mkdirSync(recoveryLock, { mode: 0o700 }); } catch { return fail("source_writer_unknown"); }
        try {
          let holder: { pid: number; processScope?: string };
          try { holder = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")); } catch { return fail("source_writer_unknown"); }
          if (!Number.isSafeInteger(holder.pid) || holder.pid < 1 || holder.processScope !== processScope) fail("source_writer_unknown");
          try { process.kill(holder.pid, 0); return fail("source_writer_active"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          fs.rmSync(lockPath, { recursive: true });
          try { fs.mkdirSync(lockPath, { mode: 0o700 }); lock = lockPath; } catch { return fail("source_writer_active"); }
        } finally { fs.rmSync(recoveryLock, { recursive: true }); }
      }
      atomic(path.join(lock!, "owner.json"), JSON.stringify({ pid: process.pid, processScope, operationId: input.operationId }));
      const directory = path.join(area, input.operationId); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      journalPath = path.join(directory, "receipt.json"); candidate = path.join(directory, "candidate");
      journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : { requestDigest, createdAt: new Date().toISOString() };
      if (journal.requestDigest !== requestDigest) fail("edit_request_conflict");
      if (input.mode !== "abort" && journal.aborted) fail("edit_aborted");
      if (recovery) {
        if (journal.commitSha && (journal.commitSha !== recovery.commitSha || journal.inputCommitSha !== recovery.inputCommitSha
          || journal.sourceDigest !== recovery.sourceDigest || journal.createdAt !== recovery.createdAt
          || journal.inspectionDigest !== recovery.inspectionDigest)) fail("source_edit_recovery_conflict");
        if (!journal.commitSha || !fs.existsSync(path.join(candidate, ".git"))) {
          fs.rmSync(candidate, { recursive: true, force: true }); fs.mkdirSync(candidate, { recursive: true });
          git(["init", "--quiet", "--initial-branch=" + input.branch], candidate);
          useCanonicalObjects(candidate);
          const bundlePath = path.join(directory, "recovery.bundle");
          try {
            fs.writeFileSync(bundlePath, bundle!, { mode: 0o600 });
            if (git(["bundle", "list-heads", bundlePath], candidate).trim() !== recovery.commitSha + " refs/heads/" + input.branch) fail("source_edit_recovery_invalid");
            git(["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", bundlePath,
              "refs/heads/" + input.branch + ":refs/paperclip/recovered-candidate"], candidate);
            if (git(["rev-parse", "refs/paperclip/recovered-candidate"], candidate).trim() !== recovery.commitSha) fail("source_edit_recovery_invalid");
            git(["update-ref", "refs/heads/" + input.branch, recovery.commitSha], candidate);
            if (git(["rev-list", "--parents", "-n1", recovery.commitSha], candidate).trim() !== recovery.commitSha + " " + recovery.inputCommitSha
              || git(["rev-list", "--parents", "-n1", recovery.inputCommitSha], candidate).trim() !== recovery.inputCommitSha + " " + input.commitSha) fail("source_edit_recovery_invalid");
            git(["read-tree", recovery.commitSha], candidate);
          } finally { fs.rmSync(bundlePath, { force: true }); }
          journal = { ...journal, createdAt: recovery.createdAt, commitSha: recovery.commitSha,
            inputCommitSha: recovery.inputCommitSha, sourceDigest: recovery.sourceDigest,
            ...(recovery.inspection ? { inspection: recovery.inspection, inspectionDigest: recovery.inspectionDigest } : {}) };
        }
        // Re-materialize after an interrupted import as well as a fresh one.
        if (git(["rev-parse", "HEAD"], candidate).trim() !== recovery.commitSha) fail("source_edit_recovery_conflict");
        restored = true;
      }
      save();
      const head = git(["rev-parse", "HEAD"]).trim();
      if (input.mode !== "abort" && head !== input.commitSha && head !== journal.commitSha) fail("edit_base_conflict");
      if (!["abort", "restore"].includes(input.mode) && !journal.published && git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) fail("workspace_dirty");
    }
    if (input.mode === "abort") {
      if (journal.published || journal.synced) fail("edit_already_published");
      // A killed SSH client does not prove receive-pack stopped. Once a push
      // was attempted, resume its fixed candidate; never release the writer
      // merely because a read currently still sees the base.
      if (journal.pushAttempted) fail("edit_publication_uncertain");
      // Another actor moving the local or remote branch is not evidence that
      // this operation pushed. Its serialized journal proves no attempt, so
      // cancellation leaves those newer files/refs untouched and releases it.
      journal.aborted = true; save();
      process.stdout.write(JSON.stringify({ ok: true, result: { operationId: input.operationId, aborted: true } }));
      return;
    }
    const changeRoot = "openspec/changes/" + input.changeId;
    const sourcePaths = (file: string) => file === "openspec/config.yaml" || file === changeRoot + "/.openspec.yaml"
      || (file.startsWith(changeRoot + "/") && (editable(file.slice(changeRoot.length + 1)) || file === changeRoot + "/review-deck.html"))
      || /^openspec\/schemas\/[A-Za-z0-9_-]+\/(?:schema\.yaml|templates\/[A-Za-z0-9_./-]+|tools\/render_review\.py)$/.test(file);
    const entries = new Map<string, { mode: string; oid: string }>();
    for (const entry of git(["ls-tree", "-rz", "--full-tree", input.commitSha, "--", "openspec"]).split("\0").filter(Boolean)) {
      const match = entry.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/s);
      if (match && sourcePaths(match[3]!)) entries.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    }
    let total = 0;
    const contents = new Map<string, string>();
    for (const [file, entry] of entries) {
      if (!["100644", "100755"].includes(entry.mode)) fail("source_missing_or_symlink", file);
      const size = Number(git(["cat-file", "-s", entry.oid]).trim());
      if (!Number.isSafeInteger(size) || size > 5_000_000 || total + size > maxBytes) fail("source_size_limit");
      const raw = cp.spawnSync("git", ["cat-file", "blob", entry.oid], { cwd: root, env, maxBuffer: maxBytes });
      if (raw.status !== 0 || raw.stdout.length !== size) fail("git_operation_failed");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.stdout); } catch { return fail("source_not_utf8_text"); }
      if (text.includes("\0")) fail("source_not_utf8_text");
      contents.set(file, text); total += size;
    }
    for (const file of input.files) {
      const before = contents.get(changeRoot + "/" + file.path);
      if ((before === undefined ? null : hash(before)) !== file.baseSha256) fail("edit_base_conflict", file.path);
    }
    const edits = input.files.filter((file) => (contents.get(changeRoot + "/" + file.path) ?? null) !== file.text);
    if (!edits.length) fail("source_unchanged");
    if (restored) {
      // A transported bundle contains Git objects, never arbitrary filesystem
      // entries. Materialize only the same bounded text inputs as preparation.
      let restoredBytes = 0;
      for (const entry of git(["ls-tree", "-rz", "--full-tree", journal.commitSha!, "--", "openspec"], candidate).split("\0").filter(Boolean)) {
        const match = entry.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/s);
        if (!match || !sourcePaths(match[3]!)) continue;
        if (!["100644", "100755"].includes(match[1]!)) fail("source_edit_recovery_invalid");
        const size = Number(git(["cat-file", "-s", match[2]!], candidate).trim());
        if (!Number.isSafeInteger(size) || size > 5_000_000 || restoredBytes + size > maxBytes) fail("source_size_limit");
        const text = git(["cat-file", "blob", match[2]!], candidate);
        if (Buffer.byteLength(text) !== size || text.includes("\0")) fail("source_not_utf8_text");
        const target = path.join(candidate, match[3]!); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, { mode: match[1] === "100755" ? 0o755 : 0o644 }); restoredBytes += size;
      }
    }
    if (!journal.commitSha) {
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true });
      fs.mkdirSync(candidate, { recursive: true });
      git(["init", "--quiet", "--initial-branch=" + input.branch], candidate);
      useCanonicalObjects(candidate);
      git(["update-ref", "refs/heads/" + input.branch, input.commitSha], candidate);
      git(["read-tree", input.commitSha], candidate);
      for (const [file, text] of contents) {
        const target = path.join(candidate, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, { mode: entries.get(file)?.mode === "100755" ? 0o755 : 0o644 });
      }
      for (const file of edits) {
        const relative = changeRoot + "/" + file.path, target = path.join(candidate, relative);
        if (file.text === null) { fs.rmSync(target); git(["update-index", "--force-remove", "--", relative], candidate); }
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.text);
          const oid = git(["hash-object", "-w", "--stdin"], candidate, file.text).trim();
          git(["update-index", "--add", "--cacheinfo", entries.get(relative)?.mode ?? "100644", oid, relative], candidate);
        }
      }
      const identity = { GIT_AUTHOR_NAME: "Paperclip OpenSpec", GIT_AUTHOR_EMAIL: "openspec@paperclip.invalid", GIT_COMMITTER_NAME: "Paperclip OpenSpec",
        GIT_COMMITTER_EMAIL: "openspec@paperclip.invalid", GIT_AUTHOR_DATE: journal.createdAt, GIT_COMMITTER_DATE: journal.createdAt };
      const message = "OpenSpec " + input.changeId + ": apply source edit\n\nOperation: " + input.operationId + "\nActor: " + input.actorUserId + "\n\n" + input.reason;
      const inputCommitSha = git(["commit-tree", git(["write-tree"], candidate).trim(), "-p", input.commitSha], candidate, message, identity).trim();
      git(["update-ref", "refs/heads/" + input.branch, inputCommitSha, input.commitSha], candidate);
      const status = JSON.parse(command("openspec", ["status", "--change", input.changeId, "--json"], candidate));
      let rendering: SourceEditInspection["cli"]["rendering"];
      if (status.schemaName === "factory-pipeline-v2") {
        if (hash(contents.get(schemaRoot + "/tools/render_review.py") ?? "") !== rendererHash) fail("renderer_version_unsupported");
        const rendered = cp.spawnSync("python3", ["-I", schemaRoot + "/tools/render_review.py", "--change", input.changeId],
          { cwd: candidate, env, encoding: "utf8", timeout: 90_000, maxBuffer: maxBytes });
        if (rendered.error || ![0, 1].includes(rendered.status ?? -1)) fail("edit_validation_failed");
        const deckPath = changeRoot + "/review-deck.html";
        rendering = { passed: rendered.status === 0 };
        if (rendered.status === 0) {
          const deck = fs.readFileSync(path.join(candidate, deckPath), "utf8");
          const data = JSON.parse([...deck.matchAll(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/g)][0]?.[1] ?? "null");
          if (data?.metadata?.sha !== inputCommitSha || data?.metadata?.shaDirty !== false || !/^[a-f0-9]{64}$/.test(data?.sourceDigest)) fail("generated_deck_invalid");
          const deckBlob = git(["hash-object", "-w", "--stdin"], candidate, deck).trim();
          git(["update-index", "--add", "--cacheinfo", entries.get(deckPath)?.mode ?? "100644", deckBlob, deckPath], candidate);
        } else {
          rendering.message = (rendered.stderr + rendered.stdout).replaceAll(candidate + "/", "").slice(0, 8000);
          // A failed generation must not leave an older deck looking current.
          fs.rmSync(path.join(candidate, deckPath), { force: true }); git(["update-index", "--force-remove", "--", deckPath], candidate);
        }
      }
      const tree = git(["write-tree"], candidate).trim(), publicationMessage = "Record OpenSpec source inspection\n\nOperation: " + input.operationId;
      const provisional = git(["commit-tree", tree, "-p", inputCommitSha], candidate, publicationMessage, identity).trim();
      git(["update-ref", "refs/heads/" + input.branch, provisional, inputCommitSha], candidate);
      const snapshot = inspectTree({ ...input, commitSha: provisional }, candidate);
      if (snapshot.inputCommitSha !== inputCommitSha) fail("source_edit_inspection_invalid");
      if (rendering) snapshot.cli.rendering = rendering;
      const checked = readInspection({ files: snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })), cli: snapshot.cli }, input.changeId, hash);
      // The commit binds the saved CLI results, allowing tool-free restoration
      // and preventing a retry from silently changing the validation outcome.
      const commitSha = git(["commit-tree", tree, "-p", inputCommitSha], candidate,
        publicationMessage + "\nInspection: " + checked.inspectionDigest + "\n", identity).trim();
      git(["update-ref", "refs/heads/" + input.branch, commitSha, provisional], candidate);
      journal = { ...journal, commitSha, inputCommitSha, sourceDigest: snapshot.sourceDigest, ...checked }; save();
    }
    let candidateBytes = 0;
    const readCandidate = (file: string): string | null => {
      const entry = git(["ls-tree", "-z", journal.commitSha!, "--", file], candidate);
      if (!entry) return null;
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/);
      if (!match || match[3] !== file) fail("source_edit_recovery_invalid");
      const size = Number(git(["cat-file", "-s", match![2]!], candidate).trim());
      if (!Number.isSafeInteger(size) || size > 5_000_000 || candidateBytes + size > maxBytes) fail("source_size_limit");
      const text = git(["cat-file", "blob", match![2]!], candidate);
      if (Buffer.byteLength(text) !== size || text.includes("\0")) fail("source_not_utf8_text");
      candidateBytes += size; return text;
    };
    let source: { files: Array<{ path: string; sha256: string; text: string }>; cli: SourceEditInspection["cli"] } | undefined;
    let deckContent: string | null = null;
    const recordedInspection = git(["show", "-s", "--format=%B", journal.commitSha!], candidate).match(/^Inspection: ([a-f0-9]{64})$/m)?.[1];
    if (recordedInspection !== journal.inspectionDigest) fail("source_edit_recovery_invalid");
    if (journal.inspection || journal.inspectionDigest) {
      const checked = readInspection(journal.inspection, input.changeId, hash);
      if (checked.inspectionDigest !== journal.inspectionDigest
        || !git(["show", "-s", "--format=%B", journal.commitSha!], candidate).includes("\nInspection: " + checked.inspectionDigest + "\n")) fail("source_edit_recovery_invalid");
      const files = checked.inspection.files.map((file) => {
        const text = readCandidate(file.path);
        if (text === null || hash(text) !== file.sha256) fail("source_edit_recovery_invalid");
        return { ...file, text: text! };
      });
      const manifest = files.filter((file) => file.path !== changeRoot + "/review-deck.html")
        .map((file) => ({ path: path.posix.relative(changeRoot, file.path), sha256: file.sha256 }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (hash(JSON.stringify(manifest).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))) !== journal.sourceDigest) fail("source_edit_recovery_invalid");
      deckContent = files.find((file) => file.path === changeRoot + "/review-deck.html")?.text ?? null;
      source = { files: files.filter((file) => file.path !== changeRoot + "/review-deck.html"), cli: checked.inspection.cli };
    }
    // The selected standard schema may leave an unrelated old deck untouched.
    const canonicalDeck = deckContent ?? readCandidate(changeRoot + "/review-deck.html");
    const deckHtml = source ? (source.cli.readiness?.deck === "verified" ? deckContent ?? "" : "") : canonicalDeck ?? "";
    const cliVersion = source?.cli.version ?? (input.mode === "restore" ? input.publication!.cliVersion : command("openspec", ["--version"], candidate).trim());
    const result = { operationId: input.operationId, baseCommitSha: input.commitSha, commitSha: journal.commitSha!, inputCommitSha: journal.inputCommitSha!,
      sourceDigest: journal.sourceDigest!, deckHtml, ...(source ? { source, inspectionDigest: journal.inspectionDigest } : {}),
      changedFiles: edits.map((file) => ({ path: file.path, beforeSha256: file.baseSha256, afterSha256: file.text === null ? null : hash(file.text) })),
      validation: { passed: source ? source.cli.readiness!.state === "ready" : true, cliVersion }, published: input.mode === "apply" || input.mode === "restore" };
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 100) fail("source_size_limit");
    if (input.mode === "prepare") {
      const bundlePath = path.join(path.dirname(candidate), "candidate.bundle");
      let recovery: SourceEditRecovery;
      try {
        fs.rmSync(bundlePath, { force: true });
        git(["bundle", "create", bundlePath, "refs/heads/" + input.branch, "^" + input.commitSha], candidate);
        if (fs.statSync(bundlePath).size > 4_000_000) fail("source_edit_recovery_size_limit");
        const bytes = fs.readFileSync(bundlePath);
        recovery = { protocol: "openspec-source-candidate/v1", operationId: input.operationId, baseCommitSha: input.commitSha,
          requestDigest, createdAt: journal.createdAt, commitSha: journal.commitSha!, inputCommitSha: journal.inputCommitSha!, sourceDigest: journal.sourceDigest!,
          bundleSha256: crypto.createHash("sha256").update(bytes).digest("hex"), bundleBase64: bytes.toString("base64"),
          ...(journal.inspection ? { inspection: journal.inspection, inspectionDigest: journal.inspectionDigest } : {}) };
      } finally { fs.rmSync(bundlePath, { force: true }); }
      process.stdout.write(JSON.stringify({ ok: true, result: { prepared: true, recovery } }));
      return;
    }
    if (input.mode === "apply") {
      const remote = () => {
        const line = git(["ls-remote", "--exit-code", input.repositorySsh, "refs/heads/" + input.branch]).trim();
        const [sha, ref] = line.split("\t");
        if (!/^[a-f0-9]{40}$/.test(sha ?? "") || ref !== "refs/heads/" + input.branch) fail("remote_revision_conflict");
        return sha;
      };
      const remoteSha = remote();
      if (remoteSha !== input.commitSha && remoteSha !== journal.commitSha) fail("remote_revision_conflict");
      if (remoteSha !== journal.commitSha) {
        // Rendering may take time. Recheck immediately before the irreversible
        // remote write, even though the host also holds the case's writer token.
        if (git(["rev-parse", "HEAD"]).trim() !== input.commitSha) fail("edit_base_conflict");
        if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) fail("workspace_dirty");
        // A host-owned pre-push hook verifies the server's advertised old OID.
        // Git's normal receive-pack CAS then protects the remaining interval.
        // This provides exact-base publication without any force-push option.
        const hooks = path.join(candidate, ".git/paperclip-push-hooks"); fs.mkdirSync(hooks, { recursive: true });
        atomic(path.join(hooks, "pre-push"), "#!/usr/bin/env node\n" +
          "const rows=require('node:fs').readFileSync(0,'utf8').trim().split('\\n').map(line=>line.split(/\\s+/));" +
          "process.exit(rows.length===1&&rows[0].length===4&&rows[0][1]===" + JSON.stringify(journal.commitSha) +
          "&&rows[0][2]===" + JSON.stringify("refs/heads/" + input.branch) + "&&rows[0][3]===" + JSON.stringify(input.commitSha) + "?0:1);\n", 0o700);
        journal.pushAttempted = true; save();
        git(["-c", "core.hooksPath=" + hooks, "push", "--porcelain", input.repositorySsh,
          journal.commitSha! + ":refs/heads/" + input.branch], candidate);
      }
      if (remote() !== journal.commitSha) fail("remote_revision_conflict");
    }
    if (input.mode === "apply" || input.mode === "restore") {
      // Restore consumes a host-recorded publication. It only imports Git
      // objects and synchronizes files/index; it never executes repo tools,
      // validates anew, queries the network, or pushes from the host mirror.
      journal.published = true; save();
      const deckPath = changeRoot + "/review-deck.html";
      const changed = [...edits.map((file) => ({ path: changeRoot + "/" + file.path, text: file.text })),
        ...((contents.get(deckPath) ?? null) !== canonicalDeck ? [{ path: deckPath, text: canonicalDeck }] : [])];
      git(["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", candidate,
        "refs/heads/" + input.branch + ":refs/paperclip/source-edits/" + input.operationId]);
      const indexPath = path.resolve(root, git(["rev-parse", "--git-path", "index"]).trim()), indexLockPath = indexPath + ".lock";
      const oldLock = fs.lstatSync(indexLockPath, { throwIfNoEntry: false });
      if (oldLock) {
        // Recover only this operation's abandoned Git lock. A foreign lock is
        // never removed; the per-workspace process lock proved our old writer ended.
        if (!journal.indexLock || !oldLock.isFile() || oldLock.dev !== journal.indexLock.dev || oldLock.ino !== journal.indexLock.ino
          || oldLock.birthtimeMs !== journal.indexLock.birthtimeMs) fail("workspace_index_locked");
        fs.unlinkSync(indexLockPath);
      }
      const fd = fs.openSync(indexLockPath, "wx", 0o600), stat = fs.fstatSync(fd);
      indexLock = { path: indexLockPath, fd, dev: stat.dev, ino: stat.ino };
      journal.indexLock = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }; save();
      const indexEntries = git(["ls-files", "--stage", "-z"]);
      const treeEntries = (sha: string) => git(["ls-tree", "-rz", "--full-tree", sha])
        .split("\0").filter(Boolean).map((entry) => entry.replace(/^(\d+) (?:blob|commit) ([a-f0-9]{40})\t/, "$1 $2 0\t")).join("\0") + "\0";
      if (indexEntries !== treeEntries(input.commitSha) && indexEntries !== treeEntries(journal.commitSha!)) fail("workspace_sync_conflict");
      if (git(["ls-files", "-v", "-z"]).split("\0").some((entry) => entry && !entry.startsWith("H "))) fail("workspace_index_unsupported");
      const changedPaths = new Set(changed.map((file) => file.path));
      const status = git(["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (status.split("\0").some((entry) => entry && !changedPaths.has(entry.slice(3)))) fail("workspace_sync_conflict");
      const confinedFile = (relative: string, create: boolean) => {
        const parts = relative.split("/"), target = path.join(root, relative);
        for (let i = 1; i <= parts.length; i++) {
          const part = path.join(root, ...parts.slice(0, i));
          if (fs.existsSync(part) || fs.lstatSync(part, { throwIfNoEntry: false })) {
            const stat = fs.lstatSync(part);
            if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) fail("source_path_escape", relative);
          } else if (i < parts.length && create) fs.mkdirSync(part);
        }
        return target;
      };
      // Check every file before touching any: on conflict the proposed candidate
      // remains reachable in its receipt and the newer workspace bytes survive.
      for (const file of changed) {
        const target = confinedFile(file.path, false), actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
        if (actual !== (contents.get(file.path) ?? null) && actual !== file.text) fail("workspace_sync_conflict", file.path);
      }
      const head = git(["rev-parse", "HEAD"]).trim();
      if (head !== input.commitSha && head !== journal.commitSha) fail("workspace_sync_conflict");
      if (head !== journal.commitSha) git(["update-ref", "refs/heads/" + input.branch, journal.commitSha!, input.commitSha]);
      for (const file of changed) {
        if (git(["rev-parse", "HEAD"]).trim() !== journal.commitSha) fail("workspace_sync_conflict");
        const target = confinedFile(file.path, file.text !== null);
        const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
        if (actual !== (contents.get(file.path) ?? null) && actual !== file.text) fail("workspace_sync_conflict", file.path);
        if (file.text === null) { if (fs.existsSync(target)) fs.unlinkSync(target); }
        else atomic(target, file.text, entries.get(file.path)?.mode === "100755" ? 0o755 : 0o644);
      }
      // Prepare a separate index, then publish it through the Git lock we own.
      // No staged edit can be overwritten between the preflight and replacement.
      const nextIndex = path.join(path.dirname(candidate), "next-index");
      fs.rmSync(nextIndex + ".lock", { force: true }); // Private to our ended/recovered operation.
      git(["read-tree", journal.commitSha!], root, undefined, { GIT_INDEX_FILE: nextIndex });
      fs.writeFileSync(fd, fs.readFileSync(nextIndex)); fs.fsyncSync(fd); fs.closeSync(fd);
      indexLock.fd = -1;
      fs.renameSync(indexLockPath, indexPath); indexLock = undefined; delete journal.indexLock; save();
      if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) fail("workspace_sync_conflict");
      journal.synced = true; save();
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const value = error as Error & { detail?: string };
    process.stdout.write(JSON.stringify({ ok: false, code: /^[a-z][a-z0-9_]*$/.test(value.message ?? "") ? value.message : "source_edit_failed", detail: value.detail }));
    process.exitCode = 1;
  } finally {
    if (indexLock) {
      if (indexLock.fd >= 0) fs.closeSync(indexLock.fd);
      const stat = fs.lstatSync(indexLock.path, { throwIfNoEntry: false });
      if (stat?.dev === indexLock.dev && stat.ino === indexLock.ino) fs.unlinkSync(indexLock.path);
    }
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    if (lock) fs.rmSync(lock, { recursive: true, force: true });
  }
}

export const workspaceSourceEditProgram = "const __name=(fn,name)=>Object.defineProperty(fn,'name',{value:name,configurable:true}); ("
  + editOpenSpec.toString() + ")(JSON.parse(require('node:fs').readFileSync(0,'utf8')), "
  + inspectOpenSpecTree.toString() + ", " + readSourceEditInspection.toString() + ")";
