import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, documentAnnotationAnchorSnapshots, issues, pipelineCases, pipelineCaseWork } from "@paperclipai/db";
import { createDocumentAnchorSelector, projectMarkdownToText, resolveProjectionRange, selectorToAnchorSnapshot,
  createPipelineAnnotationSchema, updatePipelineAnnotationSchema } from "@paperclipai/shared";
import { pipelineCaseAnnotationService, remapPipelineFeedback } from "../services/pipeline-case-annotations.js";
import { pipelineCaseWorkService } from "../services/pipeline-case-work.js";
import { putPipelineCaseDocument } from "../services/pipeline-case-documents.js";
import { pipelineService } from "../services/pipelines.js";
import { publishStageEvidence } from "../services/pipeline-stage-evidence.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function selection(markdown: string, quote = "The operator approves the proposal.") {
  const projection = projectMarkdownToText(markdown);
  const start = projection.text.indexOf(quote);
  const range = resolveProjectionRange(projection, start, start + quote.length);
  if (!range) throw new Error("Fixture selection missing");
  return createDocumentAnchorSelector(projection, range);
}
const body = "## ADDED Requirements\n\n### Requirement: Approval\n\nThe operator approves the proposal.\n";
const anchor = () => selectorToAnchorSnapshot(selection(body));

describe("conservative OpenSpec feedback anchors", () => {
  it("follows an unchanged quote within the same heading after a preceding insertion", () => {
    const next = "An introduction.\n\n" + body;
    expect(remapPipelineFeedback(anchor(), body, next)).toMatchObject({ anchorState: "active", confidence: "exact",
      anchor: { selectedText: anchor().selectedText, markdownStart: next.indexOf(anchor().selectedText) } });
  });
  it("does not attach to a renamed heading even when the quote still exists once", () => {
    expect(remapPipelineFeedback(anchor(), body, body.replace("Requirement: Approval", "Requirement: Delivery")))
      .toMatchObject({ anchorState: "orphaned", confidence: "ambiguous", anchor: null });
  });
  it("leaves duplicate quotes and fuzzy matches needing explicit reattachment", () => {
    for (const next of [body + "\n" + anchor().selectedText, body.replace("operator approves", "reviewer approves")]) {
      expect(remapPipelineFeedback(anchor(), body, next)).toMatchObject({ anchorState: "orphaned", anchor: null });
    }
  });
  it("preserves uncertainty when the selected paragraph is removed", () => {
    expect(remapPipelineFeedback(anchor(), body, "# A completely different file\nNo matching words."))
      .toMatchObject({ anchorState: "orphaned", anchor: null });
  });
  it("ignores heading-shaped lines within fenced source examples", () => {
    const fence = String.fromCharCode(96).repeat(4);
    const next = body.replace("The operator", fence + "markdown\n# Fake heading\n" + fence + "\n\nThe operator");
    expect(remapPipelineFeedback(anchor(), body, next)).toMatchObject({ anchorState: "active", confidence: "exact" });
  });
  it("requires an observed annotation version and rejects forged actor or blocking flags", () => {
    const input = { baseRevisionId: randomUUID(), baseRevisionNumber: 1, selector: selection(body), body: "Explain this decision" };
    expect(createPipelineAnnotationSchema.parse(input).feedbackKind).toBe("question");
    expect(createPipelineAnnotationSchema.safeParse({ ...input, blocking: true }).success).toBe(false);
    expect(createPipelineAnnotationSchema.safeParse({ ...input, createdByUserId: "forged" }).success).toBe(false);
    expect(updatePipelineAnnotationSchema.safeParse({ status: "resolved" }).success).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Pipeline annotation storage tests unavailable: ${support.reason}`);
suite("native pipeline case feedback storage and approval", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const actor = { type: "user" as const, userId: "board-user" };
  const feedbackActor = { actorType: "user" as const, actorId: actor.userId, userId: actor.userId };
  const plugin = { producerPluginId: randomUUID(), producerPluginKey: "test.spec-studio" };
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-feedback-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Case feedback", defaultResponsibleUserId: actor.userId,
      issuePrefix: `F${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id, svc = pipelineService(db, { heartbeat: { wakeup: async () => null } });
    const pipeline = await svc.createPipeline({ companyId, key: "openspec", name: "OpenSpec", actor });
    const review = (await svc.listStages(companyId, pipeline.id)).find((stage) => stage.key === "review")!;
    await svc.updateStage({ companyId, pipelineId: pipeline.id, stageId: review.id, actor,
      patch: { config: { ...review.config, evidencePolicy: { kind: "spec", producerPluginKey: plugin.producerPluginKey,
        requiredDocumentKeys: ["spec-source"] } } } });
    const { case: row } = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "spec", title: "A spec", stageKey: "review", actor });
    const doc = await putPipelineCaseDocument(db, { companyId, caseId: row.id, key: "spec-source", actor,
      input: { body, title: "specs/approval/spec.md", format: "markdown" } });
    const feedback = pipelineCaseAnnotationService(db);
    const input = { baseRevisionId: doc.revision!.id, baseRevisionNumber: 1, selector: selection(body), body: "Clarify authority", feedbackKind: "blocker" as const };
    const current = async () => (await db.select().from(pipelineCases).where(eq(pipelineCases.id, row.id)))[0]!;
    const publish = async () => publishStageEvidence(db, { companyId, caseId: row.id, ...plugin,
      evidence: { expectedVersion: (await current()).version, requestKey: randomUUID(), kind: "spec", revisionId: "revision-1",
        contentDigest: "a".repeat(64), documentPins: [{ key: "spec-source", revisionId: doc.revision!.id }],
        prerequisiteDecisionIds: [], readiness: "ready", details: {} } });
    return { companyId, svc, row, doc, feedback, input, current, publish };
  }
  it("stores authenticated case-owned threads, rejects foreign companies and stale source revisions", async () => {
    const f = await seed();
    await expect(f.feedback.create(randomUUID(), f.row.id, "spec-source", f.input, feedbackActor)).rejects.toMatchObject({ status: 404 });
    await expect(f.feedback.create(f.companyId, f.row.id, "spec-source", { ...f.input, baseRevisionId: randomUUID() }, feedbackActor))
      .rejects.toMatchObject({ details: { code: "stale_base_revision" } });
    const thread = await f.feedback.create(f.companyId, f.row.id, "spec-source", f.input, feedbackActor);
    expect(thread).toMatchObject({ pipelineCaseId: f.row.id, issueId: null, caseId: null, createdByUserId: actor.userId, feedbackKind: "blocker" });
    await f.feedback.reply(f.companyId, f.row.id, "spec-source", thread.id, "Added explanation", feedbackActor);
    const [saved] = await f.feedback.list(f.companyId, f.row.id, "spec-source");
    expect(saved!.comments.map((comment) => comment.authorUserId)).toEqual([actor.userId, actor.userId]);
  });
  it("invalidates a ready packet and requires an explicit blocker disposition before fresh approval", async () => {
    const f = await seed(), evidence = await f.publish();
    const thread = await f.feedback.create(f.companyId, f.row.id, "spec-source", f.input, feedbackActor);
    expect((await f.current()).stageEvidenceId).toBeNull();
    await expect(f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: evidence.caseVersion, evidenceId: evidence.id })).rejects.toMatchObject({ status: 409 });
    await expect(f.publish()).rejects.toMatchObject({ details: { code: "blocking_feedback" } });
    await expect(f.feedback.update(f.companyId, f.row.id, "spec-source", thread.id,
      { status: "resolved", expectedUpdatedAt: thread.updatedAt.toISOString() }, feedbackActor)).rejects.toMatchObject({ status: 422 });
    await f.feedback.update(f.companyId, f.row.id, "spec-source", thread.id,
      { status: "resolved", expectedUpdatedAt: thread.updatedAt.toISOString(), resolutionDisposition: "Authority confirmed with the operator" }, feedbackActor);
    const fresh = await f.publish();
    expect((await f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", actor,
      expectedVersion: fresh.caseVersion, evidenceId: fresh.id })).case.terminalKind).toBe("done");
  });
  it("remaps in the document transaction, retains deleted blockers, and reattaches without erasing history", async () => {
    const f = await seed();
    const thread = await f.feedback.create(f.companyId, f.row.id, "spec-source", f.input, feedbackActor);
    const nextBody = "## Replacement\n\nA new paragraph has different text.";
    const next = await putPipelineCaseDocument(db, { companyId: f.companyId, caseId: f.row.id, key: "spec-source", actor,
      input: { body: nextBody, format: "markdown", baseRevisionId: f.doc.revision!.id } });
    const [orphan] = await f.feedback.list(f.companyId, f.row.id, "spec-source");
    expect(orphan).toMatchObject({ status: "open", blocking: true, anchorState: "orphaned", originalRevisionId: f.doc.revision!.id,
      selectedText: anchor().selectedText, currentRevisionId: next.revision!.id });
    const reattached = await f.feedback.reanchor(f.companyId, f.row.id, "spec-source", thread.id,
      { expectedUpdatedAt: orphan!.updatedAt.toISOString(), baseRevisionId: next.revision!.id, baseRevisionNumber: 2,
        selector: selection(nextBody, "A new paragraph has different text.") }, feedbackActor);
    expect(reattached).toMatchObject({ status: "open", blocking: true, anchorState: "active", originalRevisionId: f.doc.revision!.id });
    expect(await db.select().from(documentAnnotationAnchorSnapshots).where(eq(documentAnnotationAnchorSnapshots.threadId, thread.id))).toHaveLength(2);
    await expect(f.feedback.update(f.companyId, f.row.id, "spec-source", thread.id,
      { status: "resolved", expectedUpdatedAt: new Date(0).toISOString(), resolutionDisposition: "stale" }, feedbackActor))
      .rejects.toMatchObject({ details: { code: "annotation_conflict" } });
  });
  it("checks the source revision, file digest, heading and quote against host evidence", async () => {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Prepare", status: "backlog" }).returning();
    await pipelineCaseWorkService(db, { pluginId: plugin.producerPluginId, pluginKey: plugin.producerPluginKey }).bind(f.companyId, f.row.id, issue!.id);
    await db.update(pipelineCaseWork).set({ sourceRevisionId: "source-1" }).where(eq(pipelineCaseWork.caseId, f.row.id));
    const sourceLocator = { revisionId: "source-1", artifactId: "specs/approval/spec.md", blobHash: createHash("sha256").update(body).digest("hex"),
      headingPath: ["ADDED Requirements", "Requirement: Approval"], quote: f.input.selector.quote.exact,
      prefix: f.input.selector.quote.prefix, suffix: f.input.selector.quote.suffix };
    for (const invalid of [{ revisionId: "old-source" }, { blobHash: "0".repeat(64) }, { headingPath: ["Invented"] }]) {
      await expect(f.feedback.create(f.companyId, f.row.id, "spec-source", { ...f.input, sourceLocator: { ...sourceLocator, ...invalid } }, feedbackActor))
        .rejects.toMatchObject({ details: { code: "source_locator_stale" } });
    }
    expect(await f.feedback.create(f.companyId, f.row.id, "spec-source", { ...f.input, sourceLocator }, feedbackActor))
      .toMatchObject({ sourceLocator });
  });
  it("keeps approval blocked when an old source document is omitted from a newer packet", async () => {
    const f = await seed();
    const old = await putPipelineCaseDocument(db, { companyId: f.companyId, caseId: f.row.id, key: "removed-source", actor,
      input: { body, format: "markdown" } });
    await f.feedback.create(f.companyId, f.row.id, "removed-source", { ...f.input, baseRevisionId: old.revision!.id }, feedbackActor);
    await putPipelineCaseDocument(db, { companyId: f.companyId, caseId: f.row.id, key: "removed-source", actor,
      input: { body: "", format: "markdown", baseRevisionId: old.revision!.id } });
    // publish() pins only spec-source, while the orphaned blocker lives on removed-source.
    await expect(f.publish()).rejects.toMatchObject({ details: { code: "blocking_feedback" } });
    expect(await f.feedback.listCase(f.companyId, f.row.id)).toEqual([expect.objectContaining({
      caseDocumentKey: "removed-source", status: "open", blocking: true, anchorState: "orphaned" })]);
    expect(await f.feedback.listCase(randomUUID(), f.row.id)).toEqual([]);
  });
});
