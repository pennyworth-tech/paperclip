import type { PluginWorkspaceRevisionInspection, PluginWorkspaceRevisionRequest } from "@paperclipai/plugin-sdk";

/** Read only committed source; the enclosing host program owns workspace/CAS checks.
 * This function is serialized into both the inspector and the editor. */
export function inspectOpenSpecTree(input: Pick<PluginWorkspaceRevisionRequest, "commitSha" | "branch" | "changeId">, root: string):
  Pick<PluginWorkspaceRevisionInspection, "inputCommitSha" | "files" | "cli"> & { sourceDigest: string } {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const cp = require("node:child_process") as typeof import("node:child_process");
  const maxBytes = 8 * 1024 * 1024;
  let temporary: string | undefined;
  const fail = (code: string): never => { throw new Error(code); };
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" };
  // A repository-local executable or shell string is never accepted as an inspection command.
  const run = (command: string, args: string[], cwd = root, optional = false, diagnostic = false) => {
    const result = cp.spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 45_000, maxBuffer: maxBytes, windowsHide: true });
    if (result.error || (result.status !== 0 && !optional && !(diagnostic && result.status === 1))) fail(command === "git" ? "git_inspection_failed" : "openspec_validation_failed");
    return result.status === 0 || diagnostic ? result.stdout : "";
  };
  const git = (args: string[], optional = false) => run("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], root, optional);
  try {
    const changeRoot = "openspec/changes/" + input.changeId;
    const entries = new Map<string, { mode: string; oid: string }>();
    for (const entry of git(["ls-tree", "-rz", "--full-tree", input.commitSha, "--", "openspec"]).split("\0").filter(Boolean)) {
      const match = entry.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/s);
      if (match) entries.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    }
    let total = 0;
    const blobs = new Map<string, string>();
    const read = (file: string) => {
      if (blobs.has(file)) return blobs.get(file)!;
      const entry = entries.get(file);
      if (!entry || !["100644", "100755"].includes(entry.mode)) fail("source_missing_or_symlink");
      const size = Number(git(["cat-file", "-s", entry!.oid]).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 * 1024 || total + size > maxBytes) fail("source_size_limit");
      const raw = cp.spawnSync("git", ["cat-file", "blob", entry!.oid], { cwd: root, env, timeout: 45_000, maxBuffer: maxBytes });
      if (raw.status !== 0 || raw.error || raw.stdout.length !== size) fail("git_inspection_failed");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.stdout); }
      catch { return fail("source_not_utf8_text"); }
      if (text.includes("\0")) fail("source_not_utf8_text");
      total += size; blobs.set(file, text); return text;
    };
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spec-inspect-"));
    const exportFile = (file: string) => {
      const target = path.join(temporary!, file);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, read(file), { mode: 0o600 });
    };
    // Let the CLI resolve the selected schema before exporting its outputs. This
    // avoids scanning unrelated changes or exporting supplementary deck variants.
    const configuration = ["openspec/config.yaml", changeRoot + "/.openspec.yaml"].filter((file) => entries.has(file));
    const localSchemas = [...entries.keys()].filter((file) => /^openspec\/schemas\/[A-Za-z0-9_-]+\/(?:schema\.yaml|templates\/[A-Za-z0-9_./-]+|tools\/render_review\.py)$/.test(file));
    for (const file of [...configuration, ...localSchemas]) exportFile(file);
    fs.mkdirSync(path.join(temporary, changeRoot), { recursive: true });
    const version = run("openspec", ["--version"], temporary).trim();
    let status = JSON.parse(run("openspec", ["status", "--change", input.changeId, "--json"], temporary)) as Record<string, unknown>;
    const definitions = status.artifacts as Array<{ id: string; outputPath: string; status: string }>;
    if (status.changeName !== input.changeId || typeof status.schemaName !== "string" || !/^[A-Za-z0-9_-]+$/.test(status.schemaName)
      || !Array.isArray(definitions) || !definitions.length || definitions.length > 100) fail("artifact_graph_invalid");
    for (const artifact of definitions) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(artifact.id)
        || typeof artifact.outputPath !== "string" || !artifact.outputPath || artifact.outputPath.length > 500
        || artifact.outputPath.startsWith("/") || /[\\\0]/.test(artifact.outputPath)
        || artifact.outputPath.split("/").some((part) => part === ".." || part === ".")) fail("artifact_graph_invalid");
    }
    const schemaRoot = "openspec/schemas/" + status.schemaName + "/";
    const snapshotPaths = new Set([...configuration, ...localSchemas.filter((file) => file.startsWith(schemaRoot))]);
    for (const file of entries.keys()) {
      if (!file.startsWith(changeRoot + "/")) continue;
      const relative = file.slice(changeRoot.length + 1);
      if (/^(research|proposal|design|tasks)\.md$/.test(relative) || /^specs\/[^/]+\/spec\.md$/.test(relative)
        || definitions.some((artifact) => path.posix.matchesGlob(relative, artifact.outputPath))) snapshotPaths.add(file);
    }
    if (snapshotPaths.size > 500) fail("source_size_limit");
    for (const file of snapshotPaths) exportFile(file);
    status = JSON.parse(run("openspec", ["status", "--change", input.changeId, "--json"], temporary));
    const observed = status.artifacts as typeof definitions;
    if (!Array.isArray(observed) || observed.length !== definitions.length || observed.some((artifact, index) =>
      artifact.id !== definitions[index]!.id || artifact.outputPath !== definitions[index]!.outputPath
      || !["done", "ready", "blocked"].includes(artifact.status))) fail("artifact_graph_invalid");
    const validation = JSON.parse(run("openspec", ["validate", input.changeId, "--type", "change", "--strict", "--json", "--no-interactive"], temporary, false, true)) as {
      items?: Array<{ id: string; valid: boolean }> };
    if (validation.items?.length !== 1 || validation.items[0]?.id !== input.changeId || typeof validation.items[0]?.valid !== "boolean"
      || status.isComplete !== observed.every((artifact) => artifact.status === "done")) fail("openspec_validation_failed");
    const deckRequired = status.schemaName === "factory-pipeline-v2" || definitions.some((artifact) => artifact.outputPath === "review-deck.html");
    const paths = [...snapshotPaths].filter((file) => file !== changeRoot + "/review-deck.html");
    const inputCommitSha = git(["log", "-1", "--format=%H", input.commitSha, "--", ...new Set([...paths, "openspec/config.yaml", changeRoot + "/.openspec.yaml",
      ":(glob)" + changeRoot + "/specs/**/*.md", ":(glob)" + schemaRoot + "templates/*",
      ...definitions.filter((artifact) => artifact.outputPath !== "review-deck.html").map((artifact) => ":(glob)" + changeRoot + "/" + artifact.outputPath)])]).trim();
    if (!/^[a-f0-9]{40}$/.test(inputCommitSha)) fail("source_history_missing");
    const reasons: string[] = [];
    if (status.isComplete !== true) reasons.push("artifacts_incomplete");
    if (!validation.items![0]!.valid) reasons.push("openspec_validation_failed");
    let deckState: "verified" | "missing" | "invalid" | "not_required" = "not_required";
    const verifyDeck = () => {
      const html = read(changeRoot + "/review-deck.html");
      const payloads = [...html.matchAll(/<script\s+id="review-data"\s+type="application\/json"\s*>([\s\S]*?)<\/script>/g)];
      if (payloads.length !== 1) fail("review_data_missing");
      const model = JSON.parse(payloads[0]![1]!) as { templateVersion?: string; changeId?: string;
        metadata?: { branch?: string; sha?: string; shaDirty?: boolean }; sources?: Array<{ path: string; sha256: string; text: string }> };
      if (model.templateVersion !== "review-deck/v2" || model.changeId !== input.changeId || model.metadata?.branch !== input.branch
        || model.metadata?.shaDirty !== false || !Array.isArray(model.sources) || model.sources.length < 1 || model.sources.length > 500) fail("review_binding_mismatch");
      const declared: string[] = [];
      for (const source of model.sources!) {
        if (typeof source.path !== "string" || !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(source.path)) fail("source_path_escape");
        const resolved = path.posix.resolve("/", changeRoot, source.path).slice(1);
        if (!(resolved.startsWith(changeRoot + "/") || resolved.startsWith(schemaRoot) || resolved === "openspec/config.yaml")) fail("source_path_escape");
        if (declared.includes(resolved)) fail("duplicate_source_path");
        if (!snapshotPaths.has(resolved)) fail("review_source_unexpected");
        const text = read(resolved);
        if (text !== source.text || hash(text) !== source.sha256) fail("source_bytes_mismatch");
        declared.push(resolved);
      }
      // Every canonical Markdown artifact and schema input must appear in the deck's manifest.
      for (const file of paths) if (!declared.includes(file)) fail("review_source_omitted");
      if (model.metadata?.sha !== inputCommitSha) fail("review_input_commit_mismatch");
    };
    if (deckRequired) {
      if (!snapshotPaths.has(changeRoot + "/review-deck.html")) { deckState = "missing"; reasons.push("review_deck_missing"); }
      else try { verifyDeck(); deckState = "verified"; }
      catch (error) { deckState = "invalid"; reasons.push(error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : "review_data_invalid"); }
    }
    const schemaInputs = [...snapshotPaths].filter((file) => file.startsWith("openspec/schemas/")
      || file === "openspec/config.yaml" || file === changeRoot + "/.openspec.yaml").sort().map((file) => ({ path: file, sha256: hash(read(file)) }));
    const artifacts = observed.map((artifact) => {
      const instruction = JSON.parse(run("openspec", ["instructions", artifact.id, "--change", input.changeId, "--json"], temporary)) as {
        artifactId: string; schemaName: string; outputPath: string; instruction: string; template: string; context?: unknown; rules?: unknown;
        dependencies: Array<{ id: string; done: boolean; path: string }> };
      if (instruction.artifactId !== artifact.id || instruction.schemaName !== status.schemaName || instruction.outputPath !== artifact.outputPath
        || !Array.isArray(instruction.dependencies) || instruction.dependencies.length > 100
        || new Set(instruction.dependencies.map((d) => d.id)).size !== instruction.dependencies.length
        || instruction.dependencies.some((d) => !observed.some((a) => a.id === d.id && a.outputPath === d.path && d.done === (a.status === "done")))) fail("artifact_graph_invalid");
      const files = [...entries.keys()].filter((file) => file.startsWith(changeRoot + "/")
        && path.posix.matchesGlob(file.slice(changeRoot.length + 1), artifact.outputPath)).sort().map((file) => {
        if (!snapshotPaths.has(file)) fail("review_source_omitted");
        return { path: file.slice(changeRoot.length + 1), sha256: hash(read(file)) };
      });
      if ((files.length > 0) !== (artifact.status === "done")) fail("artifact_graph_invalid");
      const instructionDigest = hash(JSON.stringify({ version, schemaName: status.schemaName, schemaInputs,
        artifactId: artifact.id, outputPath: artifact.outputPath, instruction: instruction.instruction, template: instruction.template,
        context: instruction.context ?? null, rules: instruction.rules ?? null }));
      return { id: artifact.id, outputPath: artifact.outputPath, files, dependsOn: instruction.dependencies.map((d) => d.id).sort(),
        outputDigest: hash(JSON.stringify(files)), instructionDigest, inputDigest: "" };
    });
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    if (byId.size !== artifacts.length) fail("artifact_graph_invalid");
    const visiting = new Set<string>();
    const inputs = (id: string): string => {
      const artifact = byId.get(id);
      if (!artifact || visiting.has(id)) return fail("artifact_graph_invalid");
      if (artifact.inputDigest) return artifact.inputDigest;
      visiting.add(id);
      artifact.inputDigest = hash(JSON.stringify({ instructionDigest: artifact.instructionDigest,
        dependencies: artifact.dependsOn.map((dependency) => ({ id: dependency, inputDigest: inputs(dependency), outputDigest: byId.get(dependency)!.outputDigest })) }));
      visiting.delete(id); return artifact.inputDigest;
    };
    for (const artifact of artifacts) inputs(artifact.id);
    const files = [...snapshotPaths].sort().map((file) => ({ path: file, text: read(file), sha256: hash(read(file)) }));
    const manifest = files.filter((file) => file.path !== changeRoot + "/review-deck.html")
      .map((file) => ({ path: path.posix.relative(changeRoot, file.path), sha256: file.sha256 }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const sourceDigest = hash(JSON.stringify(manifest).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
    return { inputCommitSha, sourceDigest, files, cli: { version, status, validation, artifacts,
      readiness: { state: reasons.length ? "draft" : "ready", reasons, deck: deckState } } };
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}
