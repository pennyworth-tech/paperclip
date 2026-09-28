import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, documentAnnotationAnchorSnapshots, documentAnnotationComments, documentAnnotationThreads,
  documentRevisions, documents, pipelineCaseDocuments, pipelineCaseWork } from "@paperclipai/db";
import { anchorSnapshotToSelector, createDocumentAnnotationCommentSchema, createPipelineAnnotationSchema, updatePipelineAnnotationSchema,
  reanchorPipelineAnnotationSchema,
  remapDocumentAnchor, verifyDocumentAnchorSelector, documentHeadingPath, type DocumentAnnotationAnchorSnapshot } from "@paperclipai/shared";
import { z } from "zod";
import { conflict, notFound, unprocessable } from "../errors.js";
import { invalidateEvidenceForDocuments, lockEvidenceCase } from "./pipeline-stage-evidence.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Actor = { actorType: "agent" | "user"; actorId: string; agentId?: string | null; userId?: string | null; runId?: string | null };
const nextUpdateTime = (previous: Date) => new Date(Math.max(Date.now(), previous.getTime() + 1));

async function document(tx: Tx, companyId: string, caseId: string, key: string, lock = false) {
  const query = tx.select({ link: pipelineCaseDocuments, document: documents }).from(pipelineCaseDocuments)
    .innerJoin(documents, and(eq(documents.id, pipelineCaseDocuments.documentId), eq(documents.companyId, companyId)))
    .where(and(eq(pipelineCaseDocuments.companyId, companyId), eq(pipelineCaseDocuments.caseId, caseId), eq(pipelineCaseDocuments.key, key)));
  const [row] = await (lock ? query.for("update", { of: documents }) : query);
  if (!row) throw notFound("Pipeline case document not found");
  return row.document;
}
async function thread(tx: Tx, companyId: string, caseId: string, key: string, id: string) {
  const [row] = await tx.select().from(documentAnnotationThreads).where(and(eq(documentAnnotationThreads.companyId, companyId),
    eq(documentAnnotationThreads.pipelineCaseId, caseId), eq(documentAnnotationThreads.documentKey, key), eq(documentAnnotationThreads.id, id))).for("update");
  if (!row) throw notFound("Pipeline annotation thread not found");
  return row;
}
async function audit(tx: Tx, companyId: string, caseId: string, actor: Actor, action: string, details: Record<string, unknown>) {
  await tx.insert(activityLog).values({ companyId, actorType: actor.actorType, actorId: actor.actorId,
    agentId: actor.agentId ?? null, runId: actor.runId ?? null, entityType: "pipeline_case", entityId: caseId, action, details });
}

async function verifySelection(tx: Tx, companyId: string, caseId: string, doc: typeof documents.$inferSelect,
  input: Pick<z.infer<typeof createPipelineAnnotationSchema>, "baseRevisionId" | "baseRevisionNumber" | "selector" | "sourceLocator">) {
  if (input.baseRevisionId !== doc.latestRevisionId || input.baseRevisionNumber !== doc.latestRevisionNumber) {
    throw conflict("Annotation requires the current document revision", { code: "stale_base_revision", currentRevisionId: doc.latestRevisionId });
  }
  const verification = verifyDocumentAnchorSelector({ markdown: doc.latestBody, selector: input.selector });
  if (!verification.ok || !verification.anchor) throw unprocessable("Selected quote does not match this document revision");
  if (input.sourceLocator) {
    const [work] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.caseId, caseId)));
    if (work?.sourceRevisionId !== input.sourceLocator.revisionId
      || doc.title !== input.sourceLocator.artifactId
      || input.sourceLocator.quote !== verification.anchor.selectedText
      || input.sourceLocator.blobHash !== createHash("sha256").update(doc.latestBody).digest("hex")
      || JSON.stringify(input.sourceLocator.headingPath) !== JSON.stringify(documentHeadingPath(doc.latestBody, verification.anchor.markdownStart))
      || input.sourceLocator.prefix !== verification.anchor.prefixText
      || input.sourceLocator.suffix !== verification.anchor.suffixText) {
      throw conflict("Source locator does not match the current published revision, document, and quote", { code: "source_locator_stale" });
    }
  }
  return verification.anchor;
}
/** No silent attachment to a renamed heading, duplicate quote, or fuzzy match. */
export function remapPipelineFeedback(previousAnchor: DocumentAnnotationAnchorSnapshot, previousMarkdown: string, nextMarkdown: string) {
  const remap = remapDocumentAnchor({ previousAnchor, nextMarkdown });
  if (remap.anchor && (remap.confidence !== "exact"
    || JSON.stringify(documentHeadingPath(previousMarkdown, previousAnchor.markdownStart)) !== JSON.stringify(documentHeadingPath(nextMarkdown, remap.anchor.markdownStart)))) {
    return { ...remap, anchor: null, anchorState: "orphaned" as const, confidence: "ambiguous" as const,
      reason: "Source heading or quote is ambiguous; re-anchor explicitly" };
  }
  return remap;
}
/** Caller holds the case and document locks in the publication transaction. */
export async function remapPipelineCaseThreads(tx: Tx, input: { companyId: string; caseId: string; documentId: string;
  nextRevisionId: string; nextRevisionNumber: number; nextBody: string }) {
  const rows = await tx.select().from(documentAnnotationThreads).where(and(eq(documentAnnotationThreads.companyId, input.companyId),
    eq(documentAnnotationThreads.pipelineCaseId, input.caseId), eq(documentAnnotationThreads.documentId, input.documentId),
    eq(documentAnnotationThreads.status, "open"))).for("update");
  for (const row of rows) {
    if (row.currentRevisionId === input.nextRevisionId) continue;
    const [old] = row.currentRevisionId ? await tx.select({ body: documentRevisions.body }).from(documentRevisions)
      .where(and(eq(documentRevisions.companyId, input.companyId), eq(documentRevisions.id, row.currentRevisionId))) : [];
    const previousAnchor: DocumentAnnotationAnchorSnapshot = { selectedText: row.selectedText, prefixText: row.prefixText,
      suffixText: row.suffixText, normalizedStart: row.normalizedStart, normalizedEnd: row.normalizedEnd,
      markdownStart: row.markdownStart, markdownEnd: row.markdownEnd };
    const remap = remapPipelineFeedback(previousAnchor, old?.body ?? "", input.nextBody);
    await tx.update(documentAnnotationThreads).set({ currentRevisionId: input.nextRevisionId, currentRevisionNumber: input.nextRevisionNumber,
      anchorState: remap.anchorState, anchorConfidence: remap.confidence, ...(remap.anchor ?? {}),
      anchorSelector: remap.anchor ? anchorSnapshotToSelector(remap.anchor) : row.anchorSelector, updatedAt: nextUpdateTime(row.updatedAt) })
      .where(eq(documentAnnotationThreads.id, row.id));
    await tx.insert(documentAnnotationAnchorSnapshots).values({ companyId: input.companyId, threadId: row.id, documentId: input.documentId,
      fromRevisionId: row.currentRevisionId, fromRevisionNumber: row.currentRevisionNumber, toRevisionId: input.nextRevisionId,
      toRevisionNumber: input.nextRevisionNumber, previousAnchor, nextAnchor: remap.anchor, anchorState: remap.anchorState,
      anchorConfidence: remap.confidence, failureReason: remap.anchor ? null : remap.reason });
  }
}

export function pipelineCaseAnnotationService(db: Db) {
  return {
    async listCase(companyId: string, caseId: string) {
      // Include old/removed artifacts and issue-owned threads on shared case
      // documents, so omitting a file from a new deck cannot hide its blockers.
      const rows = await db.select({ thread: documentAnnotationThreads, key: pipelineCaseDocuments.key, title: documents.title })
        .from(pipelineCaseDocuments)
        .innerJoin(documents, and(eq(documents.id, pipelineCaseDocuments.documentId), eq(documents.companyId, companyId)))
        .innerJoin(documentAnnotationThreads, and(eq(documentAnnotationThreads.documentId, documents.id), eq(documentAnnotationThreads.companyId, companyId)))
        .where(and(eq(pipelineCaseDocuments.companyId, companyId), eq(pipelineCaseDocuments.caseId, caseId)))
        .orderBy(asc(documentAnnotationThreads.createdAt));
      const comments = rows.length ? await db.select().from(documentAnnotationComments).where(and(eq(documentAnnotationComments.companyId, companyId),
        inArray(documentAnnotationComments.threadId, rows.map((row) => row.thread.id)))).orderBy(asc(documentAnnotationComments.createdAt)) : [];
      return rows.map(({ thread, key, title }) => ({ ...thread, caseDocumentKey: key, sourceTitle: title,
        comments: comments.filter((comment) => comment.threadId === thread.id) }));
    },
    async list(companyId: string, caseId: string, key: string) {
      const doc = await document(db, companyId, caseId, key);
      const rows = await db.select().from(documentAnnotationThreads).where(and(eq(documentAnnotationThreads.companyId, companyId),
        eq(documentAnnotationThreads.pipelineCaseId, caseId), eq(documentAnnotationThreads.documentId, doc.id))).orderBy(asc(documentAnnotationThreads.createdAt));
      const comments = rows.length ? await db.select().from(documentAnnotationComments).where(and(eq(documentAnnotationComments.companyId, companyId),
        inArray(documentAnnotationComments.threadId, rows.map((r) => r.id)))).orderBy(asc(documentAnnotationComments.createdAt)) : [];
      return rows.map((row) => ({ ...row, comments: comments.filter((comment) => comment.threadId === row.id) }));
    },
    async create(companyId: string, caseId: string, key: string, raw: z.input<typeof createPipelineAnnotationSchema>, actor: Actor) {
      const input = createPipelineAnnotationSchema.parse(raw);
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const doc = await document(tx, companyId, caseId, key, true);
        const anchor = await verifySelection(tx, companyId, caseId, doc, input);
        const blocking = input.feedbackKind === "blocker";
        if (blocking) await invalidateEvidenceForDocuments(tx, [doc.id]);
        const [row] = await tx.insert(documentAnnotationThreads).values({ companyId, pipelineCaseId: caseId, documentId: doc.id,
          documentKey: key, status: "open", blocking, feedbackKind: input.feedbackKind, sourceLocator: input.sourceLocator ?? null,
          anchorState: "active", anchorConfidence: "exact", originalRevisionId: doc.latestRevisionId, originalRevisionNumber: doc.latestRevisionNumber,
          currentRevisionId: doc.latestRevisionId, currentRevisionNumber: doc.latestRevisionNumber, ...anchor,
          anchorSelector: input.selector, createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null }).returning();
        const [comment] = await tx.insert(documentAnnotationComments).values({ companyId, pipelineCaseId: caseId, threadId: row!.id,
          documentId: doc.id, body: input.body, authorType: actor.actorType, authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null, createdByRunId: actor.runId ?? null }).returning();
        await audit(tx, companyId, caseId, actor, "pipeline.annotation_created", { threadId: row!.id, key, feedbackKind: input.feedbackKind });
        return { ...row!, comments: [comment!] };
      });
    },
    async reply(companyId: string, caseId: string, key: string, threadId: string, body: string, actor: Actor) {
      const input = createDocumentAnnotationCommentSchema.parse({ body });
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const row = await thread(tx, companyId, caseId, key, threadId);
        const [comment] = await tx.insert(documentAnnotationComments).values({ companyId, pipelineCaseId: caseId, threadId,
          documentId: row.documentId, body: input.body, authorType: actor.actorType, authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null, createdByRunId: actor.runId ?? null }).returning();
        await tx.update(documentAnnotationThreads).set({ updatedAt: nextUpdateTime(row.updatedAt) }).where(eq(documentAnnotationThreads.id, row.id));
        await audit(tx, companyId, caseId, actor, "pipeline.annotation_replied", { threadId, commentId: comment!.id });
        return comment!;
      });
    },
    async reanchor(companyId: string, caseId: string, key: string, threadId: string,
      raw: z.input<typeof reanchorPipelineAnnotationSchema>, actor: Actor) {
      const input = reanchorPipelineAnnotationSchema.parse(raw);
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const doc = await document(tx, companyId, caseId, key, true);
        const row = await thread(tx, companyId, caseId, key, threadId);
        if (row.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
          throw conflict("Annotation changed since it was read", { code: "annotation_conflict" });
        }
        if (row.status !== "open") throw conflict("Reopen the annotation before reattaching it");
        const anchor = await verifySelection(tx, companyId, caseId, doc, input);
        if (row.blocking) await invalidateEvidenceForDocuments(tx, [doc.id]);
        const previousAnchor = { selectedText: row.selectedText, prefixText: row.prefixText, suffixText: row.suffixText,
          normalizedStart: row.normalizedStart, normalizedEnd: row.normalizedEnd, markdownStart: row.markdownStart, markdownEnd: row.markdownEnd };
        const [updated] = await tx.update(documentAnnotationThreads).set({ ...anchor, anchorState: "active", anchorConfidence: "exact",
          anchorSelector: input.selector, currentRevisionId: doc.latestRevisionId, currentRevisionNumber: doc.latestRevisionNumber,
          sourceLocator: input.sourceLocator ?? null, updatedAt: nextUpdateTime(row.updatedAt) }).where(eq(documentAnnotationThreads.id, row.id)).returning();
        await tx.insert(documentAnnotationAnchorSnapshots).values({ companyId, threadId, documentId: doc.id,
          fromRevisionId: row.currentRevisionId, fromRevisionNumber: row.currentRevisionNumber,
          toRevisionId: doc.latestRevisionId, toRevisionNumber: doc.latestRevisionNumber, previousAnchor, nextAnchor: anchor,
          anchorState: "active", anchorConfidence: "exact" });
        await audit(tx, companyId, caseId, actor, "pipeline.annotation_reattached", { threadId,
          previousSourceLocator: row.sourceLocator, sourceLocator: input.sourceLocator ?? null });
        return updated!;
      });
    },
    async update(companyId: string, caseId: string, key: string, threadId: string, raw: z.infer<typeof updatePipelineAnnotationSchema>, actor: Actor) {
      const input = updatePipelineAnnotationSchema.parse(raw);
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const row = await thread(tx, companyId, caseId, key, threadId);
        if (row.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
          throw conflict("Annotation changed since it was read", { code: "annotation_conflict" });
        }
        if (row.status === input.status) return row;
        if (row.blocking && input.status === "resolved" && !input.resolutionDisposition?.trim()) {
          throw unprocessable("Resolving a blocker requires a disposition");
        }
        if (row.blocking) await invalidateEvidenceForDocuments(tx, [row.documentId]);
        const resolved = input.status === "resolved";
        const [updated] = await tx.update(documentAnnotationThreads).set({ status: input.status,
          resolvedByAgentId: resolved ? actor.agentId ?? null : null, resolvedByUserId: resolved ? actor.userId ?? null : null,
          resolutionDisposition: resolved ? input.resolutionDisposition ?? null : null, resolvedAt: resolved ? new Date() : null,
          updatedAt: nextUpdateTime(row.updatedAt) }).where(eq(documentAnnotationThreads.id, row.id)).returning();
        await audit(tx, companyId, caseId, actor, "pipeline.annotation_status_changed", { threadId, previousStatus: row.status,
          status: input.status, disposition: input.resolutionDisposition ?? null });
        return updated!;
      });
    },
  };
}
