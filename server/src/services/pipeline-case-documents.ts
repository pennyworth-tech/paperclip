import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  documents,
  documentRevisions,
  heartbeatRuns,
  issueDocuments,
  issues as issueRows,
  pipelineCaseDocuments,
  pipelineCases,
} from "@paperclipai/db";
import { issueDocumentKeySchema, PIPELINE_CASE_BODY_DOCUMENT_KEY } from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { documentAnnotationService } from "./document-annotations.js";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";
import {
  ensurePipelineCaseBodyDocumentFromSummary,
  PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY,
  resolvePipelineCaseConversationSource,
  type PipelineActor,
} from "./pipelines.js";

export type PipelineCaseDocumentDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The REST `PUT /cases/:caseId/documents/:key` body. The plugin host service
 * parses the SAME schema, so a plugin write is validated exactly like the
 * route's.
 */
export const upsertPipelineCaseDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  format: z.string().trim().min(1).max(80).optional().default("markdown"),
  body: z.string().max(200_000),
  changeSummary: z.string().trim().max(1_000).nullable().optional(),
  baseRevisionId: z.string().guid().nullable().optional(),
});

export type UpsertPipelineCaseDocumentInput = z.infer<typeof upsertPipelineCaseDocumentSchema>;

/** The route's own key parse, verbatim: the plugin gets the same rejection. */
export function parsePipelineDocumentKey(rawKey: unknown) {
  const parsed = issueDocumentKeySchema.safeParse(String(rawKey ?? "").trim().toLowerCase());
  if (!parsed.success) {
    throw badRequest("Invalid document key", parsed.error.issues);
  }
  return parsed.data;
}

/** Parse an upsert payload outside express (plugin callers). */
export function parsePipelineCaseDocumentInput(input: unknown): UpsertPipelineCaseDocumentInput {
  const parsed = upsertPipelineCaseDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest("Invalid pipeline case document", { code: "validation", issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function getPipelineCaseDocumentRow(
  db: PipelineCaseDocumentDb,
  input: { companyId: string; caseId: string; key: string },
) {
  return db
    .select({ link: pipelineCaseDocuments, document: documents, revision: documentRevisions })
    .from(pipelineCaseDocuments)
    .innerJoin(documents, eq(pipelineCaseDocuments.documentId, documents.id))
    .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
    .where(and(
      eq(pipelineCaseDocuments.companyId, input.companyId),
      eq(pipelineCaseDocuments.caseId, input.caseId),
      eq(pipelineCaseDocuments.key, input.key),
    ))
    .limit(1)
    .then((rows: Array<{ link: typeof pipelineCaseDocuments.$inferSelect; document: typeof documents.$inferSelect; revision: typeof documentRevisions.$inferSelect | null }>) => rows[0] ?? null);
}

/**
 * Read a case document, materializing the `body` document from the case
 * summary on first read exactly as the REST GET route does. Returns null when
 * there is nothing to read.
 */
export async function readPipelineCaseDocument(
  db: Db,
  input: { companyId: string; caseId: string; key: string },
) {
  return db.transaction(async (tx) => {
    const existing = await getPipelineCaseDocumentRow(tx, input);
    if (existing || input.key !== PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY) return existing;
    const caseRow = await tx
      .select({ summary: pipelineCases.summary })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.id, input.caseId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!caseRow?.summary?.trim()) return null;
    await ensurePipelineCaseBodyDocumentFromSummary(tx, {
      companyId: input.companyId,
      caseId: input.caseId,
      summary: caseRow.summary,
      actor: { type: "system" },
    });
    return getPipelineCaseDocumentRow(tx, input);
  });
}

/** `readPipelineCaseDocument`, but a miss is a coded 404. */
export async function requirePipelineCaseDocument(
  db: Db,
  input: { companyId: string; caseId: string; key: string },
) {
  const row = await readPipelineCaseDocument(db, input);
  if (!row) throw notFound("Pipeline case document not found", { code: "document_not_found" });
  return row;
}

function issueIdFromPipelineRunContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  const issueId = context.issueId ?? context.taskId;
  return typeof issueId === "string" && issueId.trim().length > 0 ? issueId.trim() : null;
}

export async function sourceTrustForPipelineCaseDocumentWrite(
  dbOrTx: Db | any,
  input: {
    companyId: string;
    caseId: string;
    actor: PipelineActor;
  },
) {
  if (input.actor.type !== "agent") return null;

  const conversationSource = await resolvePipelineCaseConversationSource(dbOrTx, input.companyId, input.caseId);
  let issue = conversationSource?.isActive ? conversationSource.issue : null;

  if (!issue) {
    const runIssueId = await dbOrTx
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.id, input.actor.runId),
        eq(heartbeatRuns.agentId, input.actor.agentId),
      ))
      .limit(1)
      .then((rows: Array<{ contextSnapshot: unknown }>) =>
        issueIdFromPipelineRunContext(rows[0]?.contextSnapshot),
      );

    issue = runIssueId
      ? await dbOrTx
          .select()
          .from(issueRows)
          .where(and(eq(issueRows.companyId, input.companyId), eq(issueRows.id, runIssueId)))
          .limit(1)
          .then((rows: Array<typeof issueRows.$inferSelect>) => rows[0] ?? null)
      : null;
  }

  if (!issue) return null;

  return resolveActorSourceTrustForIssue({
    db: dbOrTx as Db,
    issue: {
      id: issue.id,
      companyId: issue.companyId,
      projectId: issue.projectId,
      executionPolicy: issue.executionPolicy,
    },
    actor: {
      actorType: "agent",
      actorId: input.actor.agentId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
    },
  });
}

/**
 * Write a case document revision. The REST route and the plugin host service
 * both land here, so revisioning, the one-writer `baseRevisionId` rule, the
 * conversation-document relink and the annotation remap are identical for a
 * board user, an agent run and a plugin (`{ type: "system" }`, no run id).
 *
 * Callers own their own audit trail: the route logs pipeline activity, the
 * plugin host service logs plugin activity.
 */
export async function putPipelineCaseDocument(
  db: Db,
  input: {
    companyId: string;
    caseId: string;
    key: string;
    actor: PipelineActor;
    input: UpsertPipelineCaseDocumentInput;
  },
) {
  const { companyId, caseId, key, actor } = input;
  const payload = input.input;
  const sourceTrust = await sourceTrustForPipelineCaseDocumentWrite(db, { companyId, caseId, actor });

  const result = await db.transaction(async (tx) => {
    const existing = await getPipelineCaseDocumentRow(tx, { companyId, caseId, key });

    if (existing && !payload.baseRevisionId) {
      throw conflict("Pipeline case document update requires baseRevisionId", {
        code: "stale_base_revision",
        latestRevisionId: existing.document.latestRevisionId,
        latestRevisionNumber: existing.document.latestRevisionNumber,
      });
    }
    if (existing && payload.baseRevisionId !== existing.document.latestRevisionId) {
      throw conflict("Pipeline case document was updated by someone else", {
        code: "stale_base_revision",
        latestRevision: existing.revision
          ? {
            id: existing.revision.id,
            revisionNumber: existing.revision.revisionNumber,
            title: existing.revision.title,
            createdAt: existing.revision.createdAt,
            createdByAgentId: existing.revision.createdByAgentId,
            createdByUserId: existing.revision.createdByUserId,
          }
          : null,
        latestRevisionId: existing.document.latestRevisionId,
        latestRevisionNumber: existing.document.latestRevisionNumber,
      });
    }
    if (!existing && payload.baseRevisionId) {
      throw conflict("Pipeline case document does not exist yet", {
        code: "stale_base_revision",
        latestRevision: null,
        latestRevisionId: null,
        latestRevisionNumber: null,
      });
    }

    const now = new Date();
    const actorAgentId = actor.type === "agent" ? actor.agentId : null;
    const actorUserId = actor.type === "user" ? actor.userId : null;
    const [document] = existing
      ? await tx.update(documents).set({
        title: payload.title ?? existing.document.title,
        format: payload.format,
        updatedAt: now,
        updatedByAgentId: actorAgentId,
        updatedByUserId: actorUserId,
        sourceTrust,
      }).where(eq(documents.id, existing.document.id)).returning()
      : await tx.insert(documents).values({
        companyId,
        title: payload.title ?? key,
        format: payload.format,
        latestBody: payload.body,
        latestRevisionNumber: 1,
        createdByAgentId: actorAgentId,
        createdByUserId: actorUserId,
        updatedByAgentId: actorAgentId,
        updatedByUserId: actorUserId,
        sourceTrust,
        createdAt: now,
        updatedAt: now,
      }).returning();
    const nextRevisionNumber = existing ? existing.document.latestRevisionNumber + 1 : 1;
    const [revision] = await tx.insert(documentRevisions).values({
      companyId,
      documentId: document!.id,
      revisionNumber: nextRevisionNumber,
      title: payload.title ?? document!.title,
      format: payload.format,
      body: payload.body,
      changeSummary: payload.changeSummary ?? null,
      createdByAgentId: actorAgentId,
      createdByUserId: actorUserId,
      createdByRunId: actor.type === "agent" ? actor.runId : null,
      createdAt: now,
    }).returning();
    await tx.update(documents).set({
      title: payload.title ?? document!.title,
      format: payload.format,
      latestBody: payload.body,
      latestRevisionId: revision!.id,
      latestRevisionNumber: revision!.revisionNumber,
      updatedAt: now,
      updatedByAgentId: actorAgentId,
      updatedByUserId: actorUserId,
      sourceTrust,
    }).where(eq(documents.id, document!.id));
    if (!existing) {
      await tx.insert(pipelineCaseDocuments).values({ companyId, caseId, documentId: document!.id, key, createdAt: now, updatedAt: now });
    } else {
      await tx.update(pipelineCaseDocuments).set({ updatedAt: now }).where(eq(pipelineCaseDocuments.documentId, document!.id));
    }

    // The case-side key is "body"; the conversation issue links the same
    // document under the issue-side PIPELINE_CASE_BODY_DOCUMENT_KEY.
    if (key === PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY) {
      const conversationSource = await resolvePipelineCaseConversationSource(tx, companyId, caseId);
      if (conversationSource?.isActive) {
        await tx.insert(issueDocuments).values({
          companyId,
          issueId: conversationSource.issue.id,
          documentId: document!.id,
          key: PIPELINE_CASE_BODY_DOCUMENT_KEY,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [issueDocuments.companyId, issueDocuments.issueId, issueDocuments.key],
          set: { documentId: document!.id, updatedAt: now },
        });
      }
    }

    const linkedIssueDocuments = await tx
      .select({ issueId: issueDocuments.issueId, key: issueDocuments.key })
      .from(issueDocuments)
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.documentId, document!.id)));

    return {
      created: !existing,
      document: {
        ...document!,
        title: payload.title ?? document!.title,
        format: payload.format,
        latestBody: payload.body,
        latestRevisionId: revision!.id,
        latestRevisionNumber: revision!.revisionNumber,
        updatedAt: now,
        updatedByAgentId: actorAgentId,
        updatedByUserId: actorUserId,
        sourceTrust,
      },
      revision,
      linkedIssueDocuments,
    };
  });

  if (!result.created) {
    const documentAnnotationsSvc = documentAnnotationService(db);
    await Promise.all(result.linkedIssueDocuments.map((link) =>
      documentAnnotationsSvc.remapOpenThreadsForDocument({
        issueId: link.issueId,
        key: link.key,
        documentId: result.document.id,
        nextRevisionId: result.document.latestRevisionId,
        nextRevisionNumber: result.document.latestRevisionNumber,
        nextBody: result.document.latestBody,
      })
    ));
  }

  return result;
}
