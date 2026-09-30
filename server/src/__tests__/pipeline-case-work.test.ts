import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, pipelineCases, pipelineCaseWork, pipelineCaseWorkResults, pipelineCaseWorkTurns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { pipelineCaseWorkService, withCaseWorkWake } from "../services/pipeline-case-work.js";
import { caseWorkRunClaimCondition, hasActiveCaseWorkContinuation, isCaseWorkRunCurrent } from "../services/pipeline-case-work-execution.js";
import { issueService } from "../services/issues.js";
import { pluginPipelineAuthoring } from "../services/plugin-pipeline-authoring.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Case work storage tests unavailable: ${support.reason}`);
suite("one durable preparation task per pipeline case", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const actor = { type: "user" as const, userId: "board-user" };
  const producer = { pluginId: randomUUID(), pluginKey: "test.spec-studio" };
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-case-work-");
    db = createDb(temp.connectionString);
  }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Shared preparation",
      defaultResponsibleUserId: actor.userId, issuePrefix: `T${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const [author, editor, reviewer] = await db.insert(agents).values(["Author", "Editor", "Reviewer"]
      .map((name) => ({ companyId, name, status: "idle", adapterType: "process" }))).returning();
    const svc = pipelineService(db, { heartbeat: { wakeup: async () => null } });
    const pipeline = await svc.createPipeline({ companyId, key: "openspec", name: "OpenSpec", projectId: null, actor });
    const { case: row } = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "spec", title: "A spec", actor });
    const [issue] = await db.insert(issues).values({ companyId, title: "Prepare spec", status: "backlog" }).returning();
    const work = pipelineCaseWorkService(db, producer);
    await work.bind(companyId, row.id, issue!.id);
    const readIssue = async () => (await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]!;
    const first = { expectedTurn: 0, expectedAgentId: null, requestKey: "initial-author", role: "author" as const,
      agentId: author!.id, revisionId: null, reason: "Develop spec" };
    const start = () => work.handoff(companyId, row.id, first);
    const run = async (agentId: string) => {
      const current = await work.get(companyId, row.id);
      const [record] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: {
        issueId: issue!.id, pluginId: producer.pluginId, caseWorkTurn: { caseId: row.id, turn: current!.turn, agentId },
      } }).returning();
      await db.update(issues).set({ status: "in_progress", checkoutRunId: record!.id, executionRunId: record!.id }).where(eq(issues.id, issue!.id));
      return record!;
    };
    const release = async (runId: string) => {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ checkoutRunId: null, executionRunId: null, status: "in_review" }).where(eq(issues.id, issue!.id));
    };
    const result = (turn: number, agentId: string, runId: string) => work.recordResult(companyId, row.id,
      { expectedTurn: turn, agentId, runId, revisionId: "revision-1", contentDigest: "a".repeat(64), result: { outcome: "ready" } });
    return { companyId, svc, pipeline, row, issue: issue!, work, author: author!, editor: editor!, reviewer: reviewer!,
      readIssue, first, start, run, release, result };
  }

  it("binds once, keeps one issue through all roles, and parks without completing preparation", async () => {
    const f = await seed();
    expect((await f.work.bind(f.companyId, f.row.id, f.issue.id)).issueId).toBe(f.issue.id);
    const first = await f.start();
    expect((await f.start()).id).toBe(first.id);
    let turn = first.turn;
    let previous = f.author.id;
    for (const [role, next] of [["editor", f.editor.id], ["reviewer", f.reviewer.id], ["human", null]] as const) {
      const run = await f.run(previous);
      const result = await f.result(turn, previous, run.id);
      await f.release(run.id);
      const receipt = await f.work.handoff(f.companyId, f.row.id, { expectedTurn: turn, expectedAgentId: previous,
        role, agentId: next, requestKey: `to-${role}`, revisionId: "revision-1", priorResultId: result.id, reason: `Ready for ${role}` });
      expect(receipt.issueId).toBe(f.issue.id);
      turn = receipt.turn;
      previous = next!;
    }
    expect(await f.readIssue()).toMatchObject({ id: f.issue.id, status: "in_review", assigneeAgentId: null, checkoutRunId: null });
    const history = await f.work.get(f.companyId, f.row.id);
    expect(history!.results.map((r) => r.agentId)).toEqual([f.author.id, f.editor.id, f.reviewer.id]);
    expect(history!.turns).toHaveLength(4);
    expect((await f.start()).id).toBe(first.id);
    expect(await f.readIssue()).toMatchObject({ assigneeAgentId: null, status: "in_review" });
  });
  it("pins scoped handoffs to the observed case and source while retaining replay after later changes", async () => {
    const f = await seed();
    await db.update(pipelineCaseWork).set({ sourceRevisionId: "revision-1" }).where(eq(pipelineCaseWork.caseId, f.row.id));
    const request = { ...f.first, expectedVersion: f.row.version, expectedSourceRevisionId: "revision-1", revisionId: "revision-1" };
    await expect(f.work.handoff(f.companyId, f.row.id, { ...request, expectedVersion: f.row.version + 1 }))
      .rejects.toMatchObject({ details: { code: "case_version_conflict" } });
    await expect(f.work.handoff(f.companyId, f.row.id, { ...request, expectedSourceRevisionId: "older" }))
      .rejects.toMatchObject({ details: { code: "revision_conflict" } });
    expect((await f.work.get(f.companyId, f.row.id))!.turn).toBe(0);
    const receipt = await f.work.handoff(f.companyId, f.row.id, request);
    await db.update(pipelineCases).set({ version: f.row.version + 1 }).where(eq(pipelineCases.id, f.row.id));
    expect((await f.work.handoff(f.companyId, f.row.id, request)).id).toBe(receipt.id);
    expect((await f.work.get(f.companyId, f.row.id))!.turns).toHaveLength(1);
    expect(receipt.issueId).toBe(f.issue.id);
  });

  it("does not steal a live checkout or a still-running accepted result", async () => {
    const f = await seed(); await f.start();
    const run = await f.run(f.author.id);
    const result = await f.result(1, f.author.id, run.id);
    const next = { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "editor", role: "editor" as const,
      agentId: f.editor.id, revisionId: "revision-1", priorResultId: result.id, reason: "Brief candidate" };
    await expect(f.work.handoff(f.companyId, f.row.id, next)).rejects.toMatchObject({ details: { code: "checkout_held" } });
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    await expect(f.work.handoff(f.companyId, f.row.id, next)).rejects.toMatchObject({ details: { code: "run_active" } });
    await f.release(run.id);
    await f.work.handoff(f.companyId, f.row.id, next);
    expect(await f.readIssue()).toMatchObject({ assigneeAgentId: f.editor.id, status: "todo" });
  });

  it("serializes competing handoffs, rejects changed replay content and late results", async () => {
    const f = await seed();
    const results = await Promise.allSettled([f.start(), f.work.handoff(f.companyId, f.row.id,
      { ...f.first, requestKey: "other-first", agentId: f.editor.id })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [turn] = await db.select().from(pipelineCaseWorkTurns).where(eq(pipelineCaseWorkTurns.caseId, f.row.id));
    const currentAgent = turn!.agentId!;
    const run = await f.run(currentAgent);
    const accepted = await f.result(1, currentAgent, run.id);
    expect((await f.result(1, currentAgent, run.id)).id).toBe(accepted.id);
    await expect(f.work.recordResult(f.companyId, f.row.id, { expectedTurn: 1, agentId: currentAgent, runId: run.id,
      revisionId: "revision-1", contentDigest: "b".repeat(64), result: { outcome: "ready" } })).rejects.toMatchObject({ status: 409 });
    await f.release(run.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: currentAgent, requestKey: "correction",
      role: "author", agentId: f.reviewer.id, revisionId: "revision-1", reason: "Correction requested" });
    await expect(f.result(2, currentAgent, run.id)).rejects.toMatchObject({ details: { code: "stale_turn" } });
    expect(await f.readIssue()).toMatchObject({ assigneeAgentId: f.reviewer.id, status: "todo" });
  });

  it("rejects self review and mismatched revision handoffs", async () => {
    const f = await seed(); await f.start();
    const run = await f.run(f.author.id);
    const result = await f.result(1, f.author.id, run.id); await f.release(run.id);
    const next = { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "reviewer", role: "reviewer" as const,
      agentId: f.author.id, revisionId: "revision-1", priorResultId: result.id, reason: "Review" };
    await expect(f.work.handoff(f.companyId, f.row.id, next)).rejects.toMatchObject({ status: 403 });
    await expect(f.work.handoff(f.companyId, f.row.id, { ...next, agentId: f.reviewer.id, revisionId: "revision-2" }))
      .rejects.toMatchObject({ details: { code: "revision_conflict" } });
  });

  it("re-reviews a parked task on the same published revision and refuses an obsolete candidate", async () => {
    const f = await seed(); await f.start();
    await db.update(pipelineCaseWork).set({ sourceRevisionId: "revision-1", sourceContentDigest: "a".repeat(64) })
      .where(eq(pipelineCaseWork.caseId, f.row.id));
    const authorRun = await f.run(f.author.id), authorResult = await f.result(1, f.author.id, authorRun.id);
    await f.release(authorRun.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "brief",
      role: "editor", agentId: f.editor.id, revisionId: "revision-1", priorResultId: authorResult.id, reason: "Briefing" });
    const editorRun = await f.run(f.editor.id), editorResult = await f.result(2, f.editor.id, editorRun.id);
    await f.release(editorRun.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 2, expectedAgentId: f.editor.id, requestKey: "park",
      role: "waiting", agentId: null, revisionId: "revision-1", priorResultId: editorResult.id, reason: "Operator attention" });
    const retry = { expectedTurn: 3, expectedAgentId: null, requestKey: "re-review", role: "reviewer" as const,
      agentId: f.reviewer.id, revisionId: "revision-1", priorResultId: editorResult.id, reason: "Feedback clarified; review unchanged source" };
    await expect(f.work.handoff(f.companyId, f.row.id, { ...retry, priorResultId: authorResult.id })).rejects.toMatchObject({ details: { code: "result_conflict" } });
    await db.update(pipelineCaseWork).set({ sourceRevisionId: "revision-2" }).where(eq(pipelineCaseWork.caseId, f.row.id));
    await expect(f.work.handoff(f.companyId, f.row.id, retry)).rejects.toMatchObject({ details: { code: "result_conflict" } });
    await db.update(pipelineCaseWork).set({ sourceRevisionId: "revision-1" }).where(eq(pipelineCaseWork.caseId, f.row.id));
    const turn = await f.work.handoff(f.companyId, f.row.id, retry);
    expect(turn).toMatchObject({ issueId: f.issue.id, turn: 4, revisionId: "revision-1" });
    expect((await f.work.handoff(f.companyId, f.row.id, retry)).id).toBe(turn.id);
    expect(await f.readIssue()).toMatchObject({ id: f.issue.id, assigneeAgentId: f.reviewer.id, status: "todo" });
  });

  it("pins native adverse review events to the live reviewer's immutable result", async () => {
    const f = await seed(); await f.start();
    const authorRun = await f.run(f.author.id), authorResult = await f.result(1, f.author.id, authorRun.id); await f.release(authorRun.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "review",
      role: "reviewer", agentId: f.reviewer.id, revisionId: "revision-1", priorResultId: authorResult.id, reason: "Independent review" });
    const stages = await f.svc.listStages(f.companyId, f.pipeline.id), stage = stages.find((s) => s.key === "review")!;
    await f.svc.updateStage({ companyId: f.companyId, pipelineId: f.pipeline.id, stageId: stage.id, actor,
      patch: { config: { ...stage.config, requireApproval: true, approver: { kind: "linked_reviewer" }, requestChangesToStageKey: "intake" } } });
    const review = await f.svc.transitionCase({ companyId: f.companyId, caseId: f.row.id, toStageKey: "review", expectedVersion: f.row.version, actor });
    const reviewerRun = await f.run(f.reviewer.id);
    const decide = () => f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "request_changes",
      reason: "Requirement needs a scenario", expectedVersion: review.case.version,
      actor: { type: "agent", agentId: f.reviewer.id, runId: reviewerRun.id } });
    await expect(decide()).rejects.toMatchObject({ details: { code: "review_result_required" } });
    const result = await f.work.recordResult(f.companyId, f.row.id, { expectedTurn: 2, agentId: f.reviewer.id, runId: reviewerRun.id,
      revisionId: "revision-1", contentDigest: "a".repeat(64), result: { outcome: "request_changes" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reviewerRun.id));
    await expect(decide()).rejects.toMatchObject({ details: { code: "review_result_required" } });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, reviewerRun.id));
    const decision = await decide();
    expect(decision.reviewEvent.payload).toMatchObject({ decision: "request_changes", preparationResultId: result.id,
      preparationTurn: 2, preparationRevisionId: "revision-1", preparationContentDigest: "a".repeat(64) });
    expect(decision.reviewEvent.payload.evidence).toBeUndefined();
    expect(await f.readIssue()).toMatchObject({ id: f.issue.id, checkoutRunId: reviewerRun.id, assigneeAgentId: f.reviewer.id });
  });

  it("rejects native completion and reassignment, then completes and reopens the same task through the case", async () => {
    const f = await seed(); await f.start();
    await expect(issueService(db).update(f.issue.id, { status: "done" })).rejects.toMatchObject({ details: { code: "case_outcome_required" } });
    await expect(issueService(db).update(f.issue.id, { assigneeAgentId: f.editor.id })).rejects.toMatchObject({ details: { code: "case_handoff_required" } });
    const run = await f.run(f.author.id); const result = await f.result(1, f.author.id, run.id); await f.release(run.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "human",
      role: "human", agentId: null, revisionId: "revision-1", priorResultId: result.id, reason: "Operator review" });
    const review = await f.svc.transitionCase({ companyId: f.companyId, caseId: f.row.id, toStageKey: "review", expectedVersion: f.row.version, actor });
    const approved = await f.svc.reviewCase({ companyId: f.companyId, caseId: f.row.id, decision: "approve", expectedVersion: review.case.version, actor });
    expect(await f.readIssue()).toMatchObject({ id: f.issue.id, status: "done", assigneeAgentId: null });
    await f.svc.transitionCase({ companyId: f.companyId, caseId: f.row.id, toStageKey: "intake", expectedVersion: approved.case.version, actor });
    expect(await f.readIssue()).toMatchObject({ id: f.issue.id, status: "in_review", completedAt: null });
    expect((await f.work.get(f.companyId, f.row.id))!.issueId).toBe(f.issue.id);
  });

  it("uses authorized host case ports with cross-company and capability isolation", async () => {
    const f = await seed(); const other = await seed();
    const port = pluginPipelineAuthoring(db, { ...producer, ensureCompany: async () => {} });
    expect((await port.list({ companyId: f.companyId }))[0]!.projectId).toBeNull();
    expect(await port.createCase({ companyId: f.companyId, input: { pipelineId: f.pipeline.id, caseKey: "spec", title: "A spec" } }))
      .toEqual({ id: f.row.id, created: false });
    await expect(port.listCases({ companyId: other.companyId, pipelineId: f.pipeline.id })).rejects.toMatchObject({ status: 404 });
    await expect(f.work.bind(f.companyId, other.row.id, f.issue.id)).rejects.toMatchObject({ status: 404 });
    await expect(pipelineCaseWorkService(db, { ...producer, pluginId: randomUUID() }).handoff(f.companyId, f.row.id, f.first))
      .rejects.toMatchObject({ status: 403 });
    const eventBus = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) };
    const services = buildHostServices(db, producer.pluginId, producer.pluginKey, eventBus as never);
    const handlers = createHostClientHandlers({ pluginId: producer.pluginId, capabilities: ["pipeline.cases.read"], services });
    await expect(handlers["pipelines.cases.work.bind"]!({ companyId: f.companyId, caseId: f.row.id, issueId: f.issue.id }))
      .rejects.toThrow();
    const cases = await port.listCases({ companyId: f.companyId, pipelineId: f.pipeline.id });
    expect(cases.map((c) => c.id)).toEqual([f.row.id]);
    expect((await port.listEvents({ companyId: f.companyId, caseId: f.row.id })).items.length).toBeGreaterThan(0);
    expect(await db.select().from(pipelineCaseWorkResults).where(eq(pipelineCaseWorkResults.caseId, f.row.id))).toHaveLength(0);
  });

  it("reopens review only through configured source publication and preserves an idempotent receipt", async () => {
    const f = await seed();
    const stages = await f.svc.listStages(f.companyId, f.pipeline.id);
    for (const stage of stages) await f.svc.updateStage({ companyId: f.companyId, pipelineId: f.pipeline.id, stageId: stage.id, actor,
      patch: { config: { ...stage.config, revisionPublication: { producerPluginKey: producer.pluginKey, reopenToStageKey: "intake" } } } });
    const port = pluginPipelineAuthoring(db, { ...producer, ensureCompany: async () => {} });
    const first = { companyId: f.companyId, caseId: f.row.id, input: { expectedVersion: f.row.version, baseRevisionId: null,
      requestKey: "publish-1", revisionId: "source-1", contentDigest: "a".repeat(64), reason: "First candidate" } };
    const receipt = await port.publishRevision(first);
    expect(await port.publishRevision(first)).toEqual(receipt);
    const review = await f.svc.transitionCase({ companyId: f.companyId, caseId: f.row.id, toStageKey: "review", expectedVersion: receipt.version, actor });
    await expect(f.svc.transitionCase({ companyId: f.companyId, caseId: f.row.id, toStageKey: "intake", expectedVersion: review.case.version,
      actor: { type: "system" }, revisionPublication: { pluginKey: producer.pluginKey } } as never)).rejects.toMatchObject({ status: 403 });
    const second = { ...first, input: { ...first.input, expectedVersion: review.case.version, baseRevisionId: "source-1",
      requestKey: "publish-2", revisionId: "source-2", contentDigest: "b".repeat(64), reason: "Feedback incorporated" } };
    await expect(port.publishRevision({ ...second, input: { ...second.input, baseRevisionId: "old-source" } }))
      .rejects.toMatchObject({ details: { code: "publication_conflict" } });
    const updated = await port.publishRevision(second);
    expect(updated.version).toBe(review.case.version + 1);
    const [current] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, f.row.id));
    expect(current!.stageId).toBe(stages.find((s) => s.key === "intake")!.id);
    expect(current!.stageEvidenceId).toBeNull();
    expect((await f.work.get(f.companyId, f.row.id))!.sourceRevisionId).toBe("source-2");
    await expect(port.publishRevision({ ...second, input: { ...second.input, contentDigest: "c".repeat(64) } }))
      .rejects.toMatchObject({ details: { code: "request_conflict" } });
    const events = await port.listEvents({ companyId: f.companyId, caseId: f.row.id });
    expect(events.items.filter((event) => event.type === "review_decided")).toHaveLength(0);
  });

  it("serializes wake requests with handoffs and rejects old-turn wakes before queueing", async () => {
    const f = await seed(); await f.start();
    let signal!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { signal = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const params = { companyId: f.companyId, issueId: f.issue.id, pluginId: producer.pluginId,
      expected: { caseId: f.row.id, turn: 1, agentId: f.author.id } };
    const wake = withCaseWorkWake(db, params, async () => { signal(); await release; return "queued"; });
    await started;
    let handed = false;
    const handoff = f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id,
      requestKey: "replacement", role: "author", agentId: f.editor.id, revisionId: null, reason: "Operator retry" }).then(() => { handed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handed).toBe(false);
    finish(); expect(await wake).toBe("queued"); await handoff;
    let queued = false;
    await expect(withCaseWorkWake(db, params, async () => { queued = true; })).rejects.toMatchObject({ details: { code: "stale_turn" } });
    expect(queued).toBe(false);
    await expect(withCaseWorkWake(db, { ...params, expected: undefined }, async () => {})).rejects.toMatchObject({ status: 403 });
  });

  it("replays the durable wake after a lost response even when its run already ended", async () => {
    const f = await seed(); await f.start(); let calls = 0;
    const params = { companyId: f.companyId, issueId: f.issue.id, pluginId: producer.pluginId,
      expected: { caseId: f.row.id, turn: 1, agentId: f.author.id } };
    let recordedRun = "";
    const wake = async () => {
      calls++;
      const [request] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.author.id,
        source: "assignment", status: "queued", requestedByActorId: producer.pluginId,
        idempotencyKey: `case-work:${f.row.id}:1` }).returning();
      const run = await f.run(f.author.id); recordedRun = run.id;
      await db.update(heartbeatRuns).set({ wakeupRequestId: request!.id }).where(eq(heartbeatRuns.id, run.id));
      await f.release(run.id);
      throw new Error("response lost");
    };
    await expect(withCaseWorkWake(db, params, wake)).rejects.toThrow("response lost");
    const recovered = await withCaseWorkWake(db, params, async () => { calls++; return "duplicate"; }, (execution) => execution.runIds[0]!);
    expect(recovered).toBe(recordedRun); expect(calls).toBe(1);
    expect((await f.work.get(f.companyId, f.row.id))!.execution.state).toBe("terminal");
  });

  it("will not recover an active resultless run after issue pointers were cleared", async () => {
    const f = await seed(); await f.start(); const run = await f.run(f.author.id);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const retry = { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "recover:1", role: "author" as const,
      agentId: f.author.id, revisionId: null, recoveryRunId: run.id, reason: "Interrupted author" };
    await expect(f.work.handoff(f.companyId, f.row.id, retry)).rejects.toMatchObject({ details: { code: "run_active" } });
    await db.update(heartbeatRuns).set({ status: "scheduled_retry" }).where(eq(heartbeatRuns.id, run.id));
    await expect(f.work.handoff(f.companyId, f.row.id, retry)).rejects.toMatchObject({ details: { code: "run_active" } });
    await f.release(run.id);
    const turn = await f.work.handoff(f.companyId, f.row.id, retry);
    expect(turn).toMatchObject({ turn: 2, issueId: f.issue.id, role: "author" });
    expect((await f.work.handoff(f.companyId, f.row.id, retry)).id).toBe(turn.id);
  });

  it("retries the same resultless Editor role and revision but cannot skip to review or approval", async () => {
    const f = await seed(); await f.start();
    await db.update(pipelineCaseWork).set({ sourceRevisionId: "revision-1", sourceContentDigest: "a".repeat(64) }).where(eq(pipelineCaseWork.caseId, f.row.id));
    const author = await f.run(f.author.id), result = await f.result(1, f.author.id, author.id); await f.release(author.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "editor",
      role: "editor", agentId: f.editor.id, revisionId: "revision-1", priorResultId: result.id, reason: "Briefing" });
    const ended = await f.run(f.editor.id); await f.release(ended.id);
    const retry = { expectedTurn: 2, expectedAgentId: f.editor.id, requestKey: "recover:2", role: "editor" as const,
      agentId: f.editor.id, revisionId: "revision-1", recoveryRunId: ended.id, reason: "Editor ended without a result" };
    await expect(f.work.handoff(f.companyId, f.row.id, { ...retry, role: "reviewer", agentId: f.reviewer.id })).rejects.toMatchObject({ details: { code: "recovery_conflict" } });
    await expect(f.work.handoff(f.companyId, f.row.id, { ...retry, role: "human", agentId: null })).rejects.toMatchObject({ details: { code: "recovery_conflict" } });
    await expect(f.work.handoff(f.companyId, f.row.id, { ...retry, recoveryRunId: author.id })).rejects.toMatchObject({ details: { code: "recovery_conflict" } });
    expect(await f.work.handoff(f.companyId, f.row.id, retry)).toMatchObject({ turn: 3, role: "editor", issueId: f.issue.id, revisionId: "revision-1" });
  });

  it("fences a delayed continuation at claim time even when the same agent owns the next turn", async () => {
    const f = await seed(); await f.start(); const ended = await f.run(f.author.id); await f.release(ended.id);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "recover:1",
      role: "author", agentId: f.author.id, revisionId: null, recoveryRunId: ended.id, reason: "Retry ended run" });
    const context = { issueId: f.issue.id, pluginId: producer.pluginId, caseWorkTurn: { caseId: f.row.id, turn: 1, agentId: f.author.id } };
    const [late] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.author.id, status: "queued", contextSnapshot: context }).returning();
    expect(await isCaseWorkRunCurrent(db, f.companyId, f.issue.id, f.author.id, context)).toBe(false);
    expect(await db.update(heartbeatRuns).set({ status: "running" }).where(and(eq(heartbeatRuns.id, late!.id),
      caseWorkRunClaimCondition(f.companyId, f.issue.id, f.author.id, context))).returning()).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, late!.id)))[0]!.status).toBe("queued");
    expect(await isCaseWorkRunCurrent(db, f.companyId, f.issue.id, f.author.id, { ...context, caseWorkTurn: { ...context.caseWorkTurn, turn: 2 } })).toBe(true);
    expect(await isCaseWorkRunCurrent(db, f.companyId, f.issue.id, f.author.id, {})).toBe(false);
    const [ordinary] = await db.insert(issues).values({ companyId: f.companyId, title: "Ordinary task" }).returning();
    expect(await isCaseWorkRunCurrent(db, f.companyId, ordinary!.id, f.author.id, {})).toBe(true);
  });

  it("recognizes only live case-work continuations, including accepted results before handoff", async () => {
    const f = await seed();
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(false);
    await f.start();
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(true);
    expect(await hasActiveCaseWorkContinuation(db, randomUUID(), f.issue.id)).toBe(false);
    const run = await f.run(f.author.id);
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(true);
    await f.release(run.id);
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(false);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, run.id));
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, f.issue.id));
    const result = await f.result(1, f.author.id, run.id);
    await f.release(run.id);
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(true);
    await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "review",
      role: "reviewer", agentId: f.reviewer.id, revisionId: "revision-1", priorResultId: result.id, reason: "Review" });
    expect(await f.readIssue()).toMatchObject({ assigneeAgentId: f.reviewer.id });
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(true);
    await db.update(pipelineCases).set({ terminalKind: "cancelled" }).where(eq(pipelineCases.id, f.row.id));
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(false);
    await db.update(pipelineCases).set({ terminalKind: null, retiredAt: new Date() }).where(eq(pipelineCases.id, f.row.id));
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(false);
  });

  it("keeps a native deferred wake pending instead of assuming it was lost", async () => {
    const f = await seed(); await f.start();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.author.id, source: "assignment",
      status: "deferred_issue_execution", requestedByActorId: producer.pluginId, idempotencyKey: `case-work:${f.row.id}:1` });
    expect((await f.work.get(f.companyId, f.row.id))!.execution.state).toBe("pending");
    expect(await hasActiveCaseWorkContinuation(db, f.companyId, f.issue.id)).toBe(true);
    await expect(f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: f.author.id, requestKey: "unsafe-retry",
      role: "author", agentId: f.author.id, revisionId: null, reason: "Guessing that the wake was lost" })).rejects.toMatchObject({ details: { code: "wake_pending" } });
    let called = false;
    await withCaseWorkWake(db, { companyId: f.companyId, issueId: f.issue.id, pluginId: producer.pluginId,
      expected: { caseId: f.row.id, turn: 1, agentId: f.author.id } }, async () => { called = true; return "new"; }, (execution) => execution.state);
    expect(called).toBe(false);
  });
});
