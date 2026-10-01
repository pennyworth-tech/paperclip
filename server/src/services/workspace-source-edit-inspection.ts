import type { PluginWorkspaceRevisionInspection } from "@paperclipai/plugin-sdk";

/** Bounded metadata, bound to the candidate commit message. File bytes travel in
 * the Git bundle and are re-read during recovery without invoking authoring tools. */
export interface SourceEditInspection {
  files: Array<{ path: string; sha256: string } | Extract<PluginWorkspaceRevisionInspection["files"][number], { binary: true }>>;
  cli: PluginWorkspaceRevisionInspection["cli"];
}

/** Self-contained because the editor also serializes this function. */
export function readSourceEditInspection(raw: unknown, changeId: string, digest: (value: string) => string) {
  const fail = (): never => { throw new Error("source_edit_inspection_invalid"); };
  const value = raw as SourceEditInspection | null;
  if (!value || Buffer.byteLength(JSON.stringify(value)) > 1_000_000 || !Array.isArray(value.files) || value.files.length > 500) fail();
  const cli = value!.cli, readiness = cli?.readiness;
  const validation = cli?.validation as { items?: Array<{ id: string; valid: boolean }> } | undefined;
  if (!cli || typeof cli.version !== "string" || !cli.version || cli.version.length > 200
    || typeof cli.status?.schemaName !== "string" || !/^[A-Za-z0-9_-]+$/.test(cli.status.schemaName)
    || typeof cli.status.isComplete !== "boolean" || validation?.items?.length !== 1 || validation.items[0]?.id !== changeId
    || typeof validation.items[0]?.valid !== "boolean" || !readiness || !["ready", "draft"].includes(readiness.state)
    || !["verified", "missing", "invalid", "not_required"].includes(readiness.deck) || !Array.isArray(readiness.reasons)
    || readiness.reasons.length > 100 || readiness.reasons.some((reason) => typeof reason !== "string" || reason.length > 200)
    || (readiness.state === "ready" && (readiness.reasons.length || cli.status.isComplete !== true || !validation.items[0].valid
      || !["verified", "not_required"].includes(readiness.deck)))
    || (cli.status.schemaName === "factory-pipeline-v2" && readiness.deck === "not_required")) fail();
  const paths = new Set<string>(), root = "openspec/changes/" + changeId + "/", schema = "openspec/schemas/" + cli.status.schemaName + "/";
  let imageBytes = 0;
  for (const file of value!.files) {
    if (!file || typeof file.path !== "string" || file.path.length > 1000 || !/^[A-Za-z0-9_./-]+$/.test(file.path)
      || file.path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(file.path)
      || !(file.path.startsWith(root) || file.path.startsWith(schema) || file.path === "openspec/config.yaml")
      || !/^[a-f0-9]{64}$/.test(file.sha256)) fail();
    if ("binary" in file) {
      if (file.binary !== true || !file.path.startsWith(root)
        || !/^images\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.(?:png|jpe?g|gif|webp)$/.test(file.path.slice(root.length))
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024
        || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mediaType)
        || "text" in file || "base64" in file || "payload" in file) fail();
      imageBytes += file.bytes;
      if (imageBytes > 3 * 1024 * 1024) fail();
    }
    paths.add(file.path);
  }
  const inspection: SourceEditInspection = { files: value!.files.map((file) => "binary" in file
    ? { path: file.path, sha256: file.sha256, binary: true, bytes: file.bytes, mediaType: file.mediaType }
    : { path: file.path, sha256: file.sha256 }), cli };
  const inspectionDigest = digest(JSON.stringify(inspection));
  return { inspection, inspectionDigest };
}
