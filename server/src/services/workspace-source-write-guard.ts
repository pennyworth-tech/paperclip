import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, pipelineCases, pipelineCaseWork, workspaceOperations } from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { SourceWriteMetadata } from "./workspace-source-writing.js";

export type SourceWriteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export const SOURCE_WRITE_PHASE = "openspec.source-edit";

/** Shared with workspace cleanup. Acquire before case/work/issue rows, except
 * the dispatch advisory lock, which must precede this lock to allow synchronous
 * wake → claim without deadlocking the dispatch transaction. */
export async function lockSourceWorkspace(tx: SourceWriteDb, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"execution_workspace_lifecycle:" + workspaceId}, 0))`);
}

export async function assertWorkspaceSourceWriteAvailable(tx: SourceWriteDb, companyId: string, workspaceId: string,
  operationId?: string) {
  const [pending] = await tx.select({ id: workspaceOperations.id }).from(pipelineCaseWork)
    .innerJoin(workspaceOperations, and(eq(workspaceOperations.id, pipelineCaseWork.sourceWriteId),
      eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.executionWorkspaceId, workspaceId)))
    .where(eq(pipelineCaseWork.companyId, companyId)).limit(1);
  // The protected case pointer is authoritative, even if a generic operation
  // service were to relabel an incomplete operation's status.
  if (pending && pending.id !== operationId) throw conflict("Workspace source publication must finish first", {
    code: "source_write_pending", operationId: pending.id,
  });
}

export async function assertCaseSourceWriteAvailable(tx: SourceWriteDb, companyId: string, caseId: string) {
  const [pending] = await tx.select({ id: pipelineCaseWork.sourceWriteId }).from(pipelineCaseWork)
    .where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.caseId, caseId), isNotNull(pipelineCaseWork.sourceWriteId))).limit(1);
  if (pending) throw conflict("Finish or reconcile the pending source publication first", { code: "source_write_pending", operationId: pending.id });
}

/** Used before changing a workspace binding or claiming an issue. Re-read after
 * the lock so a concurrent binding update cannot move the claim into a reserved
 * workspace. Multiple workspace locks always use the same order. */
export async function lockIssueSourceWorkspaces(tx: SourceWriteDb, companyId: string, issueId: string, nextWorkspaceId?: string | null) {
  const [before] = await tx.select({ workspaceId: issues.executionWorkspaceId }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const ids = [...new Set([before?.workspaceId, nextWorkspaceId].filter((id): id is string => Boolean(id)))].sort();
  for (const workspaceId of ids) {
    await lockSourceWorkspace(tx, workspaceId);
    await assertWorkspaceSourceWriteAvailable(tx, companyId, workspaceId);
  }
  const [after] = await tx.select({ workspaceId: issues.executionWorkspaceId }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (before?.workspaceId !== after?.workspaceId) throw conflict("Issue workspace changed before execution", { code: "workspace_mismatch" });
  return after?.workspaceId ?? null;
}

/** Claim under the workspace fence and work row lock; unlike an unlocked SQL
 * subquery this observes a reservation/turn that committed while claim waited. */
export async function withSourceWriteClaimGuard<T>(db: Db, companyId: string, issueId: string, action: (tx: SourceWriteDb) => Promise<T>) {
  return db.transaction(async (tx) => {
    await lockSourceWriteClaim(tx, companyId, issueId);
    return action(tx);
  });
}

/** Called inside the native source-publication transaction, after its replay
 * check. A plugin cannot release the writer by supplying an arbitrary commit. */
export async function consumeSourceWritePublication(tx: SourceWriteDb, current: typeof pipelineCases.$inferSelect,
  work: typeof pipelineCaseWork.$inferSelect, input: { sourceWriteId?: string; revisionId: string; contentDigest: string;
    producerPluginId: string; producerPluginKey: string }) {
  if (!work.sourceWriteId && !input.sourceWriteId) return;
  if (!work.sourceWriteId || work.sourceWriteId !== input.sourceWriteId) {
    throw conflict("Publication must consume the case's current source writer", { code: "source_write_pending", operationId: work.sourceWriteId });
  }
  const [operation] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, work.sourceWriteId),
    eq(workspaceOperations.companyId, current.companyId))).for("update");
  const metadata = operation?.metadata as SourceWriteMetadata | null | undefined, result = metadata?.result;
  if (!operation || operation.phase !== SOURCE_WRITE_PHASE || operation.status !== "running"
    || operation.executionWorkspaceId !== current.workspaceRef?.executionWorkspaceId || operation.issueId !== work.issueId
    || metadata?.protocol !== "openspec-source-write/v1" || metadata.pluginId !== input.producerPluginId || metadata.pluginKey !== input.producerPluginKey
    || metadata.caseId !== current.id || metadata.reservedTurn !== work.turn || metadata.leaseToken || metadata.leaseUntil
    || metadata.request.commitSha !== work.sourceRevisionId || work.role !== "waiting" || work.agentId
    || result?.published !== true || result.commitSha !== input.revisionId || result.sourceDigest !== input.contentDigest
    || result.baseCommitSha !== work.sourceRevisionId || result.caseVersion !== current.version || result.workTurn !== work.turn) {
    throw conflict("Source writer has no matching completed Git receipt", { code: "source_write_not_ready", operationId: work.sourceWriteId });
  }
  await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceOperations.id, operation.id));
  await tx.update(pipelineCaseWork).set({ sourceWriteId: null, updatedAt: new Date() }).where(eq(pipelineCaseWork.id, work.id));
}

/** Acquire before issue/wake/run rows when joining an existing claim transaction. */
export async function lockSourceWriteClaim(tx: SourceWriteDb, companyId: string, issueId: string) {
  await lockIssueSourceWorkspaces(tx, companyId, issueId);
  await tx.select({ id: pipelineCaseWork.id }).from(pipelineCaseWork)
    .where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.issueId, issueId))).for("update");
}

export function isSourceWriteClaimDeferred(error: unknown): boolean {
  const code = (error as { details?: { code?: string } } | null)?.details?.code;
  return code === "source_write_pending" || code === "workspace_mismatch";
}
