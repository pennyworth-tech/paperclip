import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentAnnotationThreads, documents, pipelineCaseDocuments, pipelineCaseEvents,
  pipelineCases, pipelineStageEvidence, pipelineStages, pipelineCaseWork,
} from "@paperclipai/db";
import {
  pipelineStageEvidenceInputSchema, pipelineStageEvidencePolicySchema,
  type PipelineStageEvidenceInput,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertCaseSourceWriteAvailable } from "./workspace-source-write-guard.js";

type EvidenceDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof pipelineCases.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;
type EvidenceRow = typeof pipelineStageEvidence.$inferSelect;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function stageEvidencePolicy(stage: Pick<StageRow, "config">) {
  if (stage.config.evidencePolicy === undefined) return null;
  const parsed = pipelineStageEvidencePolicySchema.safeParse(stage.config.evidencePolicy);
  if (!parsed.success) throw unprocessable("Invalid stage evidence policy", { code: "evidence_policy_invalid" });
  return parsed.data;
}

export async function lockEvidenceCase(db: EvidenceDb, companyId: string, caseId: string) {
  const [row] = await db.select().from(pipelineCases)
    .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)))
    .for("update");
  if (!row) throw notFound("Pipeline case not found");
  return row;
}

/** Call before locking/writing a shared document or its blocking annotations. */
export async function invalidateEvidenceForDocuments(db: EvidenceDb, documentIds: string[]) {
  if (!documentIds.length) return;
  const linked = await db.select({ id: pipelineCases.id }).from(pipelineCaseDocuments)
    .innerJoin(pipelineCases, and(eq(pipelineCaseDocuments.caseId, pipelineCases.id),
      eq(pipelineCaseDocuments.companyId, pipelineCases.companyId)))
    .where(inArray(pipelineCaseDocuments.documentId, documentIds))
    .orderBy(asc(pipelineCases.id)).for("update", { of: pipelineCases });
  for (const { id } of linked) {
    // A null pointer already fails closed. Avoid changing unprotected workflows.
    await db.update(pipelineCases).set({ stageEvidenceId: null,
      version: sql`${pipelineCases.version} + 1`, updatedAt: new Date() })
      .where(and(eq(pipelineCases.id, id), sql`${pipelineCases.stageEvidenceId} is not null`));
  }
}

async function validatePins(db: EvidenceDb, current: CaseRow, stage: StageRow,
  evidence: Pick<EvidenceRow, "documentPins" | "prerequisiteDecisionIds" | "revisionId" | "contentDigest">,
  requireReady = true) {
  await assertCaseSourceWriteAvailable(db, current.companyId, current.id);
  const policy = stageEvidencePolicy(stage)!;
  const [work] = await db.select().from(pipelineCaseWork).where(eq(pipelineCaseWork.caseId, current.id));
  if (work?.sourceRevisionId && (work.sourceRevisionId !== evidence.revisionId || work.sourceContentDigest !== evidence.contentDigest)) {
    throw conflict("Evidence does not describe the published source revision", { code: "evidence_stale" });
  }
  const pins = new Map(evidence.documentPins.map((pin) => [pin.key, pin.revisionId]));
  if (pins.size !== evidence.documentPins.length || (requireReady && policy.requiredDocumentKeys.some((key) => !pins.has(key)))) {
    throw conflict("Required document evidence is missing", { code: "evidence_stale" });
  }
  const rows = await db.select({ key: pipelineCaseDocuments.key, document: documents })
    .from(pipelineCaseDocuments).innerJoin(documents, and(
      eq(pipelineCaseDocuments.documentId, documents.id), eq(documents.companyId, current.companyId)))
    .where(and(eq(pipelineCaseDocuments.companyId, current.companyId), eq(pipelineCaseDocuments.caseId, current.id),
      inArray(pipelineCaseDocuments.key, [...pins.keys()])))
    .orderBy(asc(documents.id)).for("update", { of: documents });
  if (rows.length !== pins.size || rows.some((row) => pins.get(row.key) !== row.document.latestRevisionId)) {
    throw conflict("Document revisions changed since evidence was prepared", { code: "evidence_stale" });
  }
  const [blocker] = await db.select({ id: documentAnnotationThreads.id }).from(documentAnnotationThreads)
    .innerJoin(pipelineCaseDocuments, and(eq(pipelineCaseDocuments.documentId, documentAnnotationThreads.documentId),
      eq(pipelineCaseDocuments.companyId, current.companyId), eq(pipelineCaseDocuments.caseId, current.id)))
    .where(and(eq(documentAnnotationThreads.companyId, current.companyId),
      eq(documentAnnotationThreads.blocking, true), eq(documentAnnotationThreads.status, "open"))).limit(1);
  if (requireReady && blocker) throw conflict("Blocking feedback must be resolved before approval", { code: "blocking_feedback" });

  const events = evidence.prerequisiteDecisionIds.length ? await db.select({ event: pipelineCaseEvents, stageKey: pipelineStages.key })
    .from(pipelineCaseEvents).innerJoin(pipelineStages, eq(pipelineCaseEvents.fromStageId, pipelineStages.id))
    .where(and(eq(pipelineCaseEvents.companyId, current.companyId), eq(pipelineCaseEvents.caseId, current.id),
      inArray(pipelineCaseEvents.id, evidence.prerequisiteDecisionIds))) : [];
  if (events.length !== new Set(evidence.prerequisiteDecisionIds).size) {
    throw conflict("Prerequisite decisions do not belong to this case", { code: "evidence_stale" });
  }
  const [latestPrerequisite] = requireReady && policy.prerequisiteReviewStageKey ? await db.select({ id: pipelineCaseEvents.id })
    .from(pipelineCaseEvents).innerJoin(pipelineStages, eq(pipelineCaseEvents.fromStageId, pipelineStages.id))
    .where(and(eq(pipelineCaseEvents.companyId, current.companyId), eq(pipelineCaseEvents.caseId, current.id),
      eq(pipelineCaseEvents.type, "review_decided"), eq(pipelineStages.key, policy.prerequisiteReviewStageKey)))
    .orderBy(sql`coalesce((${pipelineCaseEvents.payload}->>'decidedCaseVersion')::integer, 0) desc`,
      desc(pipelineCaseEvents.createdAt), desc(pipelineCaseEvents.id)).limit(1) : [];
  if (requireReady && policy.prerequisiteReviewStageKey && !events.some(({ event, stageKey }) => {
    const packet = event.payload.evidence as EvidenceRow | undefined;
    return event.id === latestPrerequisite?.id && event.type === "review_decided" && event.payload.decision === "approve"
      && stageKey === policy.prerequisiteReviewStageKey && packet?.revisionId === evidence.revisionId
      && packet?.contentDigest === evidence.contentDigest
      && digest([...packet.documentPins].sort((a, b) => a.key.localeCompare(b.key)))
        === digest([...evidence.documentPins].sort((a, b) => a.key.localeCompare(b.key)));
  })) throw conflict("A current prerequisite review is required", { code: "evidence_stale" });
}

/** Internal host port. Producer identity must come from the installed plugin. */
export async function publishStageEvidence(db: Db, input: {
  companyId: string; caseId: string; producerPluginId: string; producerPluginKey: string;
  evidence: PipelineStageEvidenceInput;
}) {
  const parsed = pipelineStageEvidenceInputSchema.safeParse(input.evidence);
  if (!parsed.success) throw unprocessable("Invalid stage evidence", { code: "validation", issues: parsed.error.issues });
  const candidate = parsed.data;
  if (Buffer.byteLength(JSON.stringify(candidate)) > 100_000) throw unprocessable("Evidence exceeds size limit");
  const requestDigest = digest(candidate);
  return db.transaction(async (tx) => {
    const current = await lockEvidenceCase(tx, input.companyId, input.caseId);
    const [previous] = await tx.select().from(pipelineStageEvidence).where(and(
      eq(pipelineStageEvidence.companyId, input.companyId), eq(pipelineStageEvidence.caseId, input.caseId),
      eq(pipelineStageEvidence.producerPluginId, input.producerPluginId), eq(pipelineStageEvidence.requestKey, candidate.requestKey)));
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw conflict("Evidence request key has different content", { code: "request_conflict" });
      return previous;
    }
    const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, current.stageId));
    const policy = stageEvidencePolicy(stage!);
    if (!policy || policy.producerPluginKey !== input.producerPluginKey || policy.kind !== candidate.kind) {
      throw forbidden("Plugin is not the evidence producer for this stage");
    }
    if (current.version !== candidate.expectedVersion) throw conflict("Pipeline case version conflict", { code: "case_version_conflict" });
    await validatePins(tx, current, stage!, candidate, candidate.readiness === "ready");
    const [evidence] = await tx.insert(pipelineStageEvidence).values({
      companyId: current.companyId, caseId: current.id, stageId: stage!.id,
      producerPluginId: input.producerPluginId, producerPluginKey: input.producerPluginKey,
      kind: candidate.kind, requestKey: candidate.requestKey, requestDigest,
      caseVersion: current.version + 1, policyDigest: digest(stage!.config),
      revisionId: candidate.revisionId, contentDigest: candidate.contentDigest,
      documentPins: candidate.documentPins, prerequisiteDecisionIds: candidate.prerequisiteDecisionIds,
      readiness: candidate.readiness, details: candidate.details,
    }).returning();
    await tx.update(pipelineCases).set({ stageEvidenceId: evidence!.id, version: evidence!.caseVersion, updatedAt: new Date() })
      .where(eq(pipelineCases.id, current.id));
    await tx.insert(pipelineCaseEvents).values({ companyId: current.companyId, caseId: current.id,
      type: "updated", actorType: "system", payload: { evidenceId: evidence!.id,
        producerPluginId: input.producerPluginId, producerPluginKey: input.producerPluginKey,
        previousVersion: current.version, version: evidence!.caseVersion, materialChanged: false } });
    return evidence!;
  });
}

/** Called under the case row lock by every transition path, including force. */
export async function assertStageEvidenceTransition(db: EvidenceDb, current: CaseRow, from: StageRow, to: StageRow,
  input: { evidenceId?: string | null; reviewDecision?: "approve" | "reject" | "request_changes"; reason?: string | null }) {
  const entryStage = to.config.requireApprovedEntryFromStageKey;
  if (entryStage !== undefined && (typeof entryStage !== "string" || from.key !== entryStage || input.reviewDecision !== "approve")) {
    throw conflict("This stage requires an approval from its configured review stage", { code: "review_decision_required" });
  }
  if (!stageEvidencePolicy(from)) return null;
  const adverse = input.reviewDecision === "reject" || input.reviewDecision === "request_changes"
    || (input.reason?.trim() && (to.kind === "cancelled" || to.key === from.config.requestChangesToStageKey));
  if (adverse) return null;
  if (from.kind === "review" && input.reviewDecision !== "approve") {
    throw conflict("Protected review stages require a review decision", { code: "review_decision_required" });
  }
  if (!input.evidenceId || current.stageEvidenceId !== input.evidenceId) {
    throw conflict("Current stage evidence is required", { code: "evidence_stale" });
  }
  const [evidence] = await db.select().from(pipelineStageEvidence).where(and(
    eq(pipelineStageEvidence.id, input.evidenceId), eq(pipelineStageEvidence.companyId, current.companyId),
    eq(pipelineStageEvidence.caseId, current.id), eq(pipelineStageEvidence.stageId, from.id)));
  if (!evidence || evidence.caseVersion !== current.version || evidence.readiness !== "ready"
    || evidence.policyDigest !== digest(from.config)) {
    throw conflict("Stage evidence is stale or not ready", { code: "evidence_stale" });
  }
  await validatePins(db, current, from, evidence);
  return evidence;
}
