/** A bounded, read-only inspection of a case's committed OpenSpec source. */
export interface PluginWorkspaceRevisionRequest {
  caseId: string;
  expectedVersion: number;
  expectedTurn: number;
  commitSha: string;
  repositorySsh: string;
  branch: string;
  changeId: string;
}
export interface PluginOpenSpecArtifact {
  id: string;
  outputPath: string;
  dependsOn: string[];
  files: Array<{ path: string; sha256: string }>;
  outputDigest: string;
  instructionDigest: string;
  inputDigest: string;
}
export interface PluginWorkspaceRevisionInspection {
  commitSha: string;
  inputCommitSha: string;
  repositorySsh: string;
  branch: string;
  changeId: string;
  remoteCommitSha: string;
  files: Array<{ path: string; sha256: string; text: string }>;
  cli: { version: string; status: Record<string, unknown>; validation: Record<string, unknown>;
    /** Source inspection can succeed while authoring/validation is incomplete. */
    readiness?: { state: "draft" | "ready"; reasons: string[];
      deck: "verified" | "missing" | "invalid" | "not_required" };
    rendering?: { passed: boolean; message?: string };
    /** Absent on receipts created before artifact freshness was supported. */
    artifacts?: PluginOpenSpecArtifact[] };
  inspectedAt: string;
  workspaceId: string;
  caseId: string;
  caseVersion: number;
  workTurn: number;
  inspectionDigest: string;
}

export interface PluginOpenSpecFileEdit {
  /** Change-relative Markdown path; null text deletes, null baseSha256 creates. */
  path: string; baseSha256: string | null; text: string | null;
}
export interface PluginWorkspaceEditRequest extends PluginWorkspaceRevisionRequest {
  operationId: string;
  mode: "preview" | "apply";
  files: PluginOpenSpecFileEdit[];
  actorUserId: string;
  reason: string;
}
export interface PluginWorkspaceEditResult {
  operationId: string;
  baseCommitSha: string;
  commitSha: string;
  inputCommitSha: string;
  sourceDigest: string;
  deckHtml: string;
  changedFiles: Array<{ path: string; beforeSha256: string | null; afterSha256: string | null }>;
  /** Absent on legacy complete-deck receipts; review-deck.html is in deckHtml. */
  source?: Pick<PluginWorkspaceRevisionInspection, "files" | "cli">;
  inspectionDigest?: string;
  validation: { passed: boolean; cliVersion: string };
  published: boolean;
}
/** Reuses the exact edit identity and files; the executor proves no publication occurred. */
export type PluginWorkspaceEditAbortRequest = Omit<PluginWorkspaceEditRequest, "mode">;
export interface PluginWorkspaceEditAborted { operationId: string; aborted: true }
export interface PluginWorkspaceEditReceipt extends PluginWorkspaceEditResult { caseVersion: number; workTurn: number }
export interface PluginWorkspaceEditAbortReceipt extends PluginWorkspaceEditAborted { caseVersion: number; workTurn: number }
