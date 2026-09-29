import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueDocuments, issues, pipelineCases, pipelineStageEvidence } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { putPipelineCaseDocument } from "../services/pipeline-case-documents.js";
import { documentAnnotationService } from "../services/document-annotations.js";
import { documentService } from "../services/documents.js";
import { lockEvidenceCase, publishStageEvidence } from "../services/pipeline-stage-evidence.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Stage evidence storage tests unavailable: ${support.reason}`);

suite("revision-bound pipeline stage evidence", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const actor = { type: "user" as const, userId: "board-user" };
  const plugin = { producerPluginId: randomUUID(), producerPluginKey: "test.spec-studio" };
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-stage-evidence-");
    db = createDb(temp.connectionString);
  }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Evidence", defaultResponsibleUserId: actor.userId,
      issuePrefix: `E${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const svc = pipelineService(db, { heartbeat: { wakeup: async () => null } });
    const pipeline = await svc.createPipeline({ companyId: company!.id, key: "openspec", name: "OpenSpec", actor });
    const stages = await svc.listStages(company!.id, pipeline.id);
    const review = stages.find((stage) => stage.key === "review")!;
    const done = stages.find((stage) => stage.key === "done")!;
    const policy = { kind: "spec-packet", producerPluginKey: plugin.producerPluginKey, requiredDocumentKeys: ["spec-dossier"] };
    await svc.updateStage({ companyId: company!.id, pipelineId: pipeline.id, stageId: review.id, actor,
      patch: { config: { ...review.config, evidencePolicy: policy, requestChangesToStageKey: "intake" } } });
    await svc.updateStage({ companyId: company!.id, pipelineId: pipeline.id, stageId: done.id, actor,
      patch: { config: { ...done.config, requireApprovedEntryFromStageKey: "review" } } });
    const { case: row } = await svc.ingestCase({ companyId: company!.id, pipelineId: pipeline.id,
      caseKey: "spec", title: "Specification", stageKey: "review", actor });
    const doc = await putPipelineCaseDocument(db, { companyId: company!.id, caseId: row.id, key: "spec-dossier", actor,
      input: { body: "Alpha selected text omega", format: "markdown" } });
    const evidenceInput = { expectedVersion: row.version, requestKey: randomUUID(), kind: policy.kind,
      revisionId: "spec-revision-1", contentDigest: "a".repeat(64),
      documentPins: [{ key: "spec-dossier", revisionId: doc.revision!.id }],
      prerequisiteDecisionIds: [], readiness: "ready" as const, details: { validation: "passed" } };
    const publish = (overrides = {}) => publishStageEvidence(db, { companyId: company!.id, caseId: row.id,
      ...plugin, evidence: { ...evidenceInput, ...overrides } });
    return { svc, companyId: company!.id, pipeline, review, row, doc, evidenceInput, publish };
  }

  it("publishes once on retry, snapshots evidence on approval, and keeps the receipt immutable", async () => {
    const f = await seed();
    const evidence = await f.publish();
    expect((await f.publish()).id).toBe(evidence.id);
    await expect(f.publish({ contentDigest: "b".repeat(64) })).rejects.toMatchObject({ details: { code: "request_conflict" } });
    const decision = await f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: evidence.caseVersion, evidenceId: evidence.id });
    expect(decision.case.terminalKind).toBe("done");
    expect(decision.reviewEvent.payload.evidence).toMatchObject({ id: evidence.id, revisionId: "spec-revision-1",
      documentPins: f.evidenceInput.documentPins });
    const records = await db.select().from(pipelineStageEvidence).where(eq(pipelineStageEvidence.caseId, f.row.id));
    expect(records).toHaveLength(1);
    expect(records[0]!.caseVersion).toBe(evidence.caseVersion);
  });

  it("denies missing, cross-company, wrong-producer, and foreign-document evidence", async () => {
    const f = await seed();
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: f.row.version })).rejects.toMatchObject({ details: { code: "evidence_stale" } });
    await expect(publishStageEvidence(db, { ...plugin, companyId: randomUUID(), caseId: f.row.id,
      evidence: f.evidenceInput })).rejects.toMatchObject({ status: 404 });
    await expect(publishStageEvidence(db, { ...plugin, producerPluginKey: "wrong.plugin", companyId: f.companyId,
      caseId: f.row.id, evidence: f.evidenceInput })).rejects.toMatchObject({ status: 403 });
    const other = await seed();
    await expect(f.publish({ documentPins: [{ key: "spec-dossier", revisionId: other.doc.revision!.id }] }))
      .rejects.toMatchObject({ details: { code: "evidence_stale" } });
  });

  it("refuses direct, forced, suggested, and ingest bypasses while allowing an adverse review", async () => {
    const f = await seed();
    const evidence = await f.publish();
    await expect(f.svc.transitionCase({ companyId: f.companyId, caseId: f.row.id, toStageKey: "done",
      expectedVersion: evidence.caseVersion, evidenceId: evidence.id, actor, force: true, reason: "override" }))
      .rejects.toMatchObject({ details: { code: "review_decision_required" } });
    const suggestion = await f.svc.suggestTransition({ companyId: f.companyId, caseId: f.row.id,
      toStageKey: "done", rationale: "Please approve", actor });
    await expect(f.svc.resolveSuggestion({ companyId: f.companyId, caseId: f.row.id,
      suggestionId: suggestion.case.pendingSuggestion!.id, decision: "accept", actor }))
      .rejects.toMatchObject({ details: { code: "review_decision_required" } });
    await expect(f.svc.ingestCase({ companyId: f.companyId, pipelineId: f.pipeline.id, caseKey: "skip",
      title: "Skip review", stageKey: "done", actor })).rejects.toMatchObject({ details: { code: "review_decision_required" } });
    const result = await f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id,
      decision: "request_changes", reason: "Needs correction", expectedVersion: evidence.caseVersion, actor });
    expect(result.case.terminalKind).toBeNull();
    expect(result.reviewEvent.payload.evidence).toBeUndefined();
  });

  it("invalidates native case and linked issue document edits without accepting forged case fields", async () => {
    const f = await seed();
    const evidence = await f.publish();
    const revised = await putPipelineCaseDocument(db, { companyId: f.companyId, caseId: f.row.id, key: "spec-dossier", actor,
      input: { body: "Changed evidence", format: "markdown", baseRevisionId: f.doc.revision!.id } });
    const [current] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, f.row.id));
    expect(current!.stageEvidenceId).toBeNull();
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: current!.version, evidenceId: evidence.id })).rejects.toMatchObject({ details: { code: "evidence_stale" } });
    const fresh = await f.publish({ requestKey: randomUUID(), expectedVersion: current!.version,
      documentPins: [{ key: "spec-dossier", revisionId: revised.revision!.id }] });
    const changed = await f.svc.patchCaseContent({ companyId: f.companyId, caseId: f.row.id, actor,
      expectedVersion: fresh.caseVersion, fields: { stageEvidenceId: fresh.id, approved: true } });
    expect(changed.stageEvidenceId).toBeNull();
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: changed.version, evidenceId: fresh.id })).rejects.toMatchObject({ details: { code: "evidence_stale" } });
  });

  async function annotationFixture() {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Shared preparation", status: "in_review" }).returning();
    await db.insert(issueDocuments).values({ companyId: f.companyId, issueId: issue!.id, documentId: f.doc.document.id, key: "spec-dossier" });
    const annotations = documentAnnotationService(db);
    const annotationInput = { baseRevisionId: f.doc.revision!.id, baseRevisionNumber: 1,
      body: "Review concern", selector: { quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
        position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 } } };
    const annotationActor = { actorType: "user" as const, actorId: actor.userId, userId: actor.userId };
    return { ...f, issue: issue!, annotations, annotationInput, annotationActor };
  }

  it("keeps nonblocking notes valid and invalidates/resolves native blockers with an explicit disposition", async () => {
    const f = await annotationFixture();
    const evidence = await f.publish();
    await f.annotations.createThread(f.issue.id, "spec-dossier", f.annotationInput, f.annotationActor);
    const [before] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, f.row.id));
    expect(before!.stageEvidenceId).toBe(evidence.id);
    const blocker = await f.annotations.createThread(f.issue.id, "spec-dossier", { ...f.annotationInput, blocking: true }, f.annotationActor);
    const [blocked] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, f.row.id));
    expect(blocked!.stageEvidenceId).toBeNull();
    await expect(f.publish({ requestKey: randomUUID(), expectedVersion: blocked!.version }))
      .rejects.toMatchObject({ details: { code: "blocking_feedback" } });
    await expect(f.annotations.updateThread(f.issue.id, "spec-dossier", blocker.id, { status: "resolved" }, f.annotationActor))
      .rejects.toMatchObject({ status: 422 });
    const resolved = await f.annotations.updateThread(f.issue.id, "spec-dossier", blocker.id,
      { status: "resolved", resolutionDisposition: "Accepted the documented tradeoff" }, f.annotationActor);
    expect(resolved.resolutionDisposition).toBe("Accepted the documented tradeoff");
    expect(resolved.resolvedByUserId).toBe(actor.userId);
    const refreshed = await f.publish({ requestKey: randomUUID(), expectedVersion: blocked!.version });
    expect(refreshed.id).not.toBe(evidence.id);
    await documentService(db).upsertIssueDocument({ issueId: f.issue.id, key: "spec-dossier", format: "markdown",
      body: "Edited through native issue API", baseRevisionId: f.doc.revision!.id, createdByUserId: actor.userId });
    const [after] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, f.row.id));
    expect(after!.stageEvidenceId).toBeNull();
  });

  it("serializes a concurrent document write before an approval reading the old packet", async () => {
    const f = await seed();
    const evidence = await f.publish();
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const writer = db.transaction(async (tx) => {
      await lockEvidenceCase(tx, f.companyId, f.row.id);
      await tx.update(pipelineCases).set({ stageEvidenceId: null, version: evidence.caseVersion + 1 })
        .where(and(eq(pipelineCases.id, f.row.id), eq(pipelineCases.companyId, f.companyId)));
      locked();
      await release;
    });
    await held;
    const decision = f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: evidence.caseVersion, evidenceId: evidence.id }).then(() => null, (error) => error);
    unlock();
    await writer;
    expect(await decision).toMatchObject({ status: 409 });
  });

  it("requires the same reviewed packet at the human gate and rejects agent approval", async () => {
    const f = await seed();
    const human = await f.svc.createStage({ companyId: f.companyId, pipelineId: f.pipeline.id,
      key: "human", name: "Human approval", kind: "review", position: 500, actor,
      config: { requireApproval: true, approver: { kind: "any_human" }, approveToStageKey: "done",
        requestChangesToStageKey: "intake", rejectToStageKey: "cancelled", requireApprovedEntryFromStageKey: "review",
        evidencePolicy: { kind: "spec-packet", producerPluginKey: plugin.producerPluginKey,
          requiredDocumentKeys: ["spec-dossier"], prerequisiteReviewStageKey: "review" } } });
    const stages = await f.svc.listStages(f.companyId, f.pipeline.id);
    const review = stages.find((stage) => stage.key === "review")!;
    await f.svc.updateStage({ companyId: f.companyId, pipelineId: f.pipeline.id, stageId: review.id, actor,
      patch: { config: { ...review.config, approveToStageKey: "human" } } });
    const done = stages.find((stage) => stage.key === "done")!;
    await f.svc.updateStage({ companyId: f.companyId, pipelineId: f.pipeline.id, stageId: done.id, actor,
      patch: { config: { ...done.config, requireApprovedEntryFromStageKey: "human" } } });
    const evidence = await f.publish();
    const technical = await f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: evidence.caseVersion, evidenceId: evidence.id });
    expect(technical.case.stageId).toBe(human.id);
    const candidate = { expectedVersion: technical.case.version, requestKey: randomUUID() };
    await expect(f.publish(candidate)).rejects.toMatchObject({ details: { code: "evidence_stale" } });
    await expect(f.publish({ ...candidate, prerequisiteDecisionIds: [technical.reviewEvent.id], contentDigest: "b".repeat(64) }))
      .rejects.toMatchObject({ details: { code: "evidence_stale" } });
    const packet = await f.publish({ ...candidate, prerequisiteDecisionIds: [technical.reviewEvent.id] });
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve",
      actor: { type: "agent", agentId: randomUUID(), runId: randomUUID() }, expectedVersion: packet.caseVersion,
      evidenceId: packet.id })).rejects.toMatchObject({ status: 403 });
    const approved = await f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: packet.caseVersion, evidenceId: packet.id });
    expect(approved.reviewEvent.payload.evidence).toMatchObject({ prerequisiteDecisionIds: [technical.reviewEvent.id] });
  });

  it("rolls back inline approval edits and rejects non-ready receipts", async () => {
    const f = await seed();
    const evidence = await f.publish();
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, actor, decision: "approve",
      evidenceId: evidence.id, expectedVersion: evidence.caseVersion, edits: { title: "Changed during approval" } }))
      .rejects.toMatchObject({ details: { code: "evidence_stale" } });
    const [unchanged] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, f.row.id));
    expect(unchanged!.title).toBe("Specification");
    expect(unchanged!.version).toBe(evidence.caseVersion);
    const pending = await f.publish({ expectedVersion: evidence.caseVersion, requestKey: randomUUID(), readiness: "not_ready" });
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, actor, decision: "approve",
      evidenceId: pending.id, expectedVersion: pending.caseVersion }))
      .rejects.toMatchObject({ details: { code: "evidence_stale" } });
  });

  it("mints evidence only through the granted company-scoped host capability", async () => {
    const f = await seed();
    const eventBus = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) };
    const services = buildHostServices(db, plugin.producerPluginId, plugin.producerPluginKey, eventBus as never);
    const denied = createHostClientHandlers({ pluginId: plugin.producerPluginKey, capabilities: ["pipeline.cases.read"], services });
    const params = { companyId: f.companyId, caseId: f.row.id, evidence: f.evidenceInput };
    await expect(denied["pipelines.cases.publishEvidence"](params)).rejects.toThrow();
    const granted = createHostClientHandlers({ pluginId: plugin.producerPluginKey,
      capabilities: ["pipeline.cases.evidence.write"], services });
    await expect(granted["pipelines.cases.publishEvidence"](params,
      { invocationScope: { companyId: randomUUID() } })).rejects.toThrow();
    const receipt = await granted["pipelines.cases.publishEvidence"](params,
      { invocationScope: { companyId: f.companyId } });
    const [stored] = await db.select().from(pipelineStageEvidence).where(eq(pipelineStageEvidence.id, receipt.id));
    expect(stored!.producerPluginId).toBe(plugin.producerPluginId);
    expect(stored!.producerPluginKey).toBe(plugin.producerPluginKey);
  });
});
