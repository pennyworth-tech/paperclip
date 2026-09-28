import { createHash } from "node:crypto";
import type { PluginWorkspaceEditAbortRequest } from "@paperclipai/plugin-sdk";
import { conflict, unprocessable } from "../errors.js";
import { readSourceEditInspection, type SourceEditInspection } from "./workspace-source-edit-inspection.js";

/** Host-only transport. Plugins can supply Markdown edits, never this bundle. */
export interface SourceEditRecovery {
  protocol: "openspec-source-candidate/v1";
  operationId: string;
  baseCommitSha: string;
  requestDigest: string;
  createdAt: string;
  commitSha: string;
  inputCommitSha: string;
  sourceDigest: string;
  bundleSha256: string;
  bundleBase64: string;
  inspection?: SourceEditInspection;
  inspectionDigest?: string;
}
export type SourceEditProgramInput = PluginWorkspaceEditAbortRequest & {
  mode: "preview" | "prepare" | "apply" | "abort" | "restore";
  recovery?: SourceEditRecovery;
  publication?: SourceCopyPublication;
};
export interface SourceCopyPublication {
  cwd: string;
  operationId: string;
  baseCommitSha: string;
  commitSha: string;
  inputCommitSha: string;
  sourceDigest: string;
  cliVersion: string;
  inspectionDigest?: string;
}
export type SourceEditCheckpoint = { recovery?: SourceEditRecovery; publicationDispatched?: boolean; copyPublication?: SourceCopyPublication };
export type PreparedSourceEditCheckpoint = SourceEditCheckpoint & { recovery: SourceEditRecovery; publicationDispatched: boolean };
export type WorkspaceProgramExecution = { stdout: string; exitCode: number | null; copyRestoreCwd?: string };

export function sourceEditCandidateRequestDigest(input: PluginWorkspaceEditAbortRequest) {
  return createHash("sha256").update(JSON.stringify({ operationId: input.operationId, commitSha: input.commitSha,
    repositorySsh: input.repositorySsh, branch: input.branch, changeId: input.changeId,
    actorUserId: input.actorUserId, reason: input.reason, files: input.files })).digest("hex");
}

export function readSourceEditRecovery(value: unknown, input: PluginWorkspaceEditAbortRequest): SourceEditRecovery {
  const r = value as SourceEditRecovery | null;
  if (!r || r.protocol !== "openspec-source-candidate/v1" || r.operationId !== input.operationId
    || r.baseCommitSha !== input.commitSha || r.requestDigest !== sourceEditCandidateRequestDigest(input)
    || typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))
    || !/^[a-f0-9]{40}$/.test(r.commitSha) || !/^[a-f0-9]{40}$/.test(r.inputCommitSha)
    || !/^[a-f0-9]{64}$/.test(r.sourceDigest) || !/^[a-f0-9]{64}$/.test(r.bundleSha256)
    || typeof r.bundleBase64 !== "string" || !r.bundleBase64.length || r.bundleBase64.length > 5_333_336) {
    throw unprocessable("Invalid durable source candidate", { code: "source_edit_recovery_invalid" });
  }
  const bundle = Buffer.from(r.bundleBase64, "base64");
  if (bundle.length > 4_000_000 || bundle.toString("base64") !== r.bundleBase64
    || createHash("sha256").update(bundle).digest("hex") !== r.bundleSha256) {
    throw unprocessable("Invalid source candidate bundle", { code: "source_edit_recovery_invalid" });
  }
  // Drop unexpected fields before persisting or forwarding a remote receipt.
  let checked: ReturnType<typeof readSourceEditInspection> | undefined;
  if (r.inspection || r.inspectionDigest) {
    try { checked = readSourceEditInspection(r.inspection, input.changeId, (value) => createHash("sha256").update(value).digest("hex")); }
    catch { throw unprocessable("Invalid source inspection checkpoint", { code: "source_edit_recovery_invalid" }); }
    if (checked.inspectionDigest !== r.inspectionDigest) throw unprocessable("Source inspection checkpoint changed", { code: "source_edit_recovery_invalid" });
  }
  return { protocol: r.protocol, operationId: r.operationId, baseCommitSha: r.baseCommitSha, requestDigest: r.requestDigest,
    createdAt: r.createdAt, commitSha: r.commitSha, inputCommitSha: r.inputCommitSha, sourceDigest: r.sourceDigest,
    bundleSha256: r.bundleSha256, bundleBase64: r.bundleBase64, ...(checked ?? {}) };
}

/** Prepare cannot push. Publication is dispatched only after the host has
 * durably stored both the exact candidate and its dispatch marker. A missing
 * response must never allow a new candidate or an unproven abandonment. */
export async function runDurableSourceEdit(input: PluginWorkspaceEditAbortRequest, abort: boolean, checkpoint: SourceEditCheckpoint, ports: {
  execute(input: SourceEditProgramInput): Promise<WorkspaceProgramExecution>;
  save(checkpoint: PreparedSourceEditCheckpoint): Promise<void>;
  restore?(input: SourceEditProgramInput, cwd: string): Promise<WorkspaceProgramExecution>;
}): Promise<WorkspaceProgramExecution> {
  if (abort) {
    if (checkpoint.copyPublication) throw conflict("This edit is published; resume restoring its workspace", { code: "edit_already_published" });
    if (checkpoint.publicationDispatched) throw conflict("Publication may have started; resume this operation", { code: "edit_publication_uncertain" });
    // An in-flight prepare can finish after this cancellation, but it cannot
    // acquire the native lease to save its candidate or dispatch publication.
    return { stdout: JSON.stringify({ ok: true, result: { operationId: input.operationId, aborted: true } }), exitCode: 0 };
  }
  let recovery = checkpoint.recovery ? readSourceEditRecovery(checkpoint.recovery, input) : undefined;
  const restore = async (publication: SourceCopyPublication) => {
    if (!recovery || !ports.restore || publication.operationId !== input.operationId || publication.baseCommitSha !== input.commitSha
      || publication.commitSha !== recovery.commitSha || publication.inputCommitSha !== recovery.inputCommitSha
      || publication.sourceDigest !== recovery.sourceDigest || publication.inspectionDigest !== recovery.inspectionDigest
      || typeof publication.cwd !== "string" || !publication.cwd.startsWith("/")
      || typeof publication.cliVersion !== "string" || !publication.cliVersion || publication.cliVersion.length > 200) {
      throw conflict("The published copy needs its recorded restoration checkpoint", { code: "source_copy_receipt_invalid" });
    }
    return ports.restore({ ...input, mode: "restore", recovery, publication }, publication.cwd);
  };
  if (checkpoint.copyPublication) {
    if (!checkpoint.publicationDispatched) throw conflict("Copy publication was not dispatched", { code: "source_copy_receipt_invalid" });
    return restore(checkpoint.copyPublication);
  }
  if (!recovery) {
    if (checkpoint.publicationDispatched) throw conflict("The dispatched candidate needs recovery", { code: "source_edit_recovery_missing" });
    const execution = await ports.execute({ ...input, mode: "prepare" });
    let response: { ok?: boolean; result?: { prepared?: boolean; recovery?: unknown } };
    try { response = JSON.parse(execution.stdout); } catch { throw unprocessable("Invalid preparation receipt", { code: "source_edit_failed" }); }
    // Let the normal source-edit response parser preserve a typed executor failure.
    if (execution.exitCode !== 0 || !response.ok) return execution;
    if (response.result?.prepared !== true) throw unprocessable("Source preparation did not return a candidate", { code: "source_edit_recovery_invalid" });
    recovery = readSourceEditRecovery(response.result.recovery, input);
    await ports.save({ recovery, publicationDispatched: false });
  }
  await ports.save({ recovery, publicationDispatched: true });
  const execution = await ports.execute({ ...input, mode: "apply", recovery });
  if (!execution.copyRestoreCwd) return execution;
  let response: { ok?: boolean; result?: { operationId: string; baseCommitSha: string; commitSha: string; inputCommitSha: string;
    sourceDigest: string; inspectionDigest?: string; published?: boolean; validation?: { passed?: boolean; cliVersion?: string } } };
  try { response = JSON.parse(execution.stdout); } catch { throw unprocessable("Invalid copy publication receipt", { code: "source_copy_receipt_invalid" }); }
  if (execution.exitCode !== 0 || !response.ok) return execution;
  const result = response.result;
  if (!result || result.published !== true || result.operationId !== input.operationId || result.baseCommitSha !== input.commitSha
    || result.commitSha !== recovery.commitSha || result.inputCommitSha !== recovery.inputCommitSha || result.sourceDigest !== recovery.sourceDigest
    || result.inspectionDigest !== recovery.inspectionDigest
    || result.validation?.passed !== (recovery.inspection ? recovery.inspection.cli.readiness!.state === "ready" : true)
    || typeof result.validation?.cliVersion !== "string"
    || !result.validation.cliVersion || result.validation.cliVersion.length > 200) {
    throw unprocessable("Copy publication does not match the prepared candidate", { code: "source_copy_receipt_invalid" });
  }
  const copyPublication: SourceCopyPublication = { cwd: execution.copyRestoreCwd, operationId: result.operationId, baseCommitSha: result.baseCommitSha,
    commitSha: result.commitSha, inputCommitSha: result.inputCommitSha, sourceDigest: result.sourceDigest, cliVersion: result.validation.cliVersion,
    ...(recovery.inspectionDigest ? { inspectionDigest: recovery.inspectionDigest } : {}) };
  // Persist success before any canonical Git/index/filesystem mutation. If
  // restoration fails, retry does not need a surviving remote environment.
  await ports.save({ recovery, publicationDispatched: true, copyPublication });
  return restore(copyPublication);
}
