import type { PluginWorkspaceRevisionInspection } from "@paperclipai/plugin-sdk";

/** Bounded metadata, bound to the candidate commit message. File bytes travel in
 * the Git bundle and are re-read during recovery without invoking authoring tools. */
export interface SourceEditInspection {
  files: Array<{ path: string; sha256: string }>;
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
    || (cli.status.reviewDeckRequired !== undefined && typeof cli.status.reviewDeckRequired !== "boolean")
    || typeof cli.status.isComplete !== "boolean" || validation?.items?.length !== 1 || validation.items[0]?.id !== changeId
    || typeof validation.items[0]?.valid !== "boolean" || !readiness || !["ready", "draft"].includes(readiness.state)
    || !["verified", "missing", "invalid", "not_required"].includes(readiness.deck) || !Array.isArray(readiness.reasons)
    || readiness.reasons.length > 100 || readiness.reasons.some((reason) => typeof reason !== "string" || reason.length > 200)
    || (readiness.state === "ready" && (readiness.reasons.length || cli.status.isComplete !== true || !validation.items[0].valid
      || !["verified", "not_required"].includes(readiness.deck)))
    || ((cli.status.reviewDeckRequired === true || (Array.isArray(cli.status.artifacts)
      && cli.status.artifacts.some((artifact: { outputPath?: unknown }) => artifact?.outputPath === "review-deck.html")))
      && readiness.deck === "not_required")) fail();
  const paths = new Set<string>(), root = "openspec/changes/" + changeId + "/", schema = "openspec/schemas/" + cli.status.schemaName + "/";
  for (const file of value!.files) {
    if (!file || typeof file.path !== "string" || file.path.length > 1000 || !/^[A-Za-z0-9_./-]+$/.test(file.path)
      || file.path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(file.path)
      || !(file.path.startsWith(root) || file.path.startsWith(schema) || file.path === "openspec/config.yaml")
      || !/^[a-f0-9]{64}$/.test(file.sha256)) fail();
    paths.add(file.path);
  }
  const inspection: SourceEditInspection = { files: value!.files.map(({ path, sha256 }) => ({ path, sha256 })), cli };
  const inspectionDigest = digest(JSON.stringify(inspection));
  return { inspection, inspectionDigest };
}
