import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { STALE_RUN_LOCK_AGE_OUT_ERROR_CODE, STALE_RUN_LOCK_AGE_OUT_MS } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale execution lock age-out tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Comfortably outside the age-out window, and comfortably inside it.
const agedAt = () => new Date(Date.now() - STALE_RUN_LOCK_AGE_OUT_MS - 60 * 60 * 1000);
const recentAt = () => new Date(Date.now() - 30 * 60 * 1000);

describeEmbeddedPostgres("dead non-terminal execution lock age-out", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-age-out-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  /** Company + agent + the actor's own live run (the fenced-out assignee). */
  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: currentRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });

    return { companyId, agentId, currentRunId };
  }

  async function insertRun(
    values: Partial<typeof heartbeatRuns.$inferInsert> & { companyId: string; agentId: string; status: string },
  ) {
    const id = values.id ?? randomUUID();
    await db.insert(heartbeatRuns).values({ invocationSource: "manual", ...values, id });
    return id;
  }

  /** in_progress, assigned to the agent, fenced by executionRunId with no checkout owner. */
  async function insertFencedIssue(companyId: string, agentId: string, executionRunId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fenced by a dead non-terminal run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: agedAt(),
    });
    return issueId;
  }

  const readIssue = (issueId: string) =>
    db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

  const readRun = (runId: string) =>
    db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        livenessState: heartbeatRuns.livenessState,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);

  // ── A dead running run releases the fence ─────────────────────────────────

  it("lets the assignee PATCH past a running run that has been silent past the window", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    // Worker restart, or a remote adapter call that hung: started, then silent,
    // and it never wrote a terminal status. reapOrphanedRuns skips exactly this
    // shape when the run is still in the in-memory execution map and the
    // adapter has no local pid to check.
    const deadRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: agedAt(),
      processStartedAt: agedAt(),
      lastOutputAt: agedAt(),
      lastUsefulActionAt: agedAt(),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, deadRunId);
    // The cross-issue influence gate refuses an agent write whose run carries
    // no source issue, so the actor run names this issue, exactly as the
    // surrounding cases do. Same-issue writes short-circuit the cap.
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recorded after the fence aged out" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readIssue(issueId)).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    // The dead run is given a terminal verdict, so every status-only consumer
    // of the lock columns agrees with the adoption from here on.
    const deadRun = await readRun(deadRunId);
    expect(deadRun.status).toBe("cancelled");
    expect(deadRun.errorCode).toBe(STALE_RUN_LOCK_AGE_OUT_ERROR_CODE);
    // Left null on purpose: "dead" is not a member of RUN_LIVENESS_STATES, and
    // a null here keeps the run eligible for activity.ts's classification
    // backfill, which selects on `isNull(livenessState)`.
    expect(deadRun.livenessState).toBeNull();
    expect(deadRun.finishedAt).not.toBeNull();
  });

  it("lets the assignee release past a running run whose process is gone", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    // Worker restart / crash: started, then silent, and never wrote a terminal status.
    const deadRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: agedAt(),
      processStartedAt: agedAt(),
      lastOutputAt: agedAt(),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, deadRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readIssue(issueId)).toEqual({ checkoutRunId: null, executionRunId: null });
    expect((await readRun(deadRunId)).status).toBe("cancelled");
  });

  it("lets the assignee check out past a dead non-terminal execution lock", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const deadRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: agedAt(),
      processStartedAt: agedAt(),
      lastOutputAt: agedAt(),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, deadRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_progress", "todo", "backlog"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readIssue(issueId)).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  // ── Pending and recent runs are protected ─────────────────────────────────

  it("does NOT age out a queued run that is still pending dispatch, however old it is", async () => {
    // A queued run can sit for the better part of an hour and
    // then start normally. Elapsed age is not a death signal — upstream says
    // so itself, in reapOrphanedRuns: "queued runs are legitimately waiting;
    // resumeQueuedRuns handles them".
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "issue_comment",
      status: "queued",
      requestedAt: agedAt(),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const pendingRunId = await insertRun({
      companyId,
      agentId,
      status: "queued",
      startedAt: null,
      wakeupRequestId: wakeupId,
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, pendingRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Must not steal the lock from a pending run" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // The pending run keeps both its status and the lock — no data loss.
    expect((await readRun(pendingRunId)).status).toBe("queued");
    expect(await readIssue(issueId)).toEqual({
      checkoutRunId: null,
      executionRunId: pendingRunId,
    });
  });

  it("does NOT age out a running run that produced output inside the window", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const liveRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: agedAt(),
      processStartedAt: agedAt(),
      lastOutputAt: recentAt(),
      createdAt: agedAt(),
      updatedAt: recentAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, liveRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Must not adopt a slow but live run" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await readRun(liveRunId)).status).toBe("running");
  });

  it("does NOT age out a run with a retry still scheduled ahead of it", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const retryingRunId = await insertRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      startedAt: null,
      scheduledRetryAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, retryingRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Must not adopt ahead of a scheduled retry" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await readRun(retryingRunId)).status).toBe("scheduled_retry");
  });

  it("does NOT age out a queued run whose wakeup row was already retired", async () => {
    // The wakeup table is NOT what dispatch consults: resumeQueuedRuns and
    // startNextQueuedRunForAgent select on heartbeatRuns.status = 'queued'
    // alone. So a retired wake is not evidence the run is dead — the run is
    // still selectable, and cancelling it would delete assigned work.
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "issue_comment",
      status: "skipped",
      requestedAt: agedAt(),
      finishedAt: agedAt(),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const orphanRunId = await insertRun({
      companyId,
      agentId,
      status: "queued",
      startedAt: null,
      wakeupRequestId: wakeupId,
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, orphanRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "A retired wake must not license adoption" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await readRun(orphanRunId)).status).toBe("queued");
  });

  it("does NOT age out a queued run with no wakeup row at all, at any age", async () => {
    // The strongest form of the queued guarantee: with no wake to consult and
    // nothing but elapsed time to go on, the answer is still "leave it alone".
    // This is the test that fails if a createdAt-keyed threshold ever returns.
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const ancientRunId = await insertRun({
      companyId,
      agentId,
      status: "queued",
      startedAt: null,
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const issueId = await insertFencedIssue(companyId, agentId, ancientRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Age alone must never license adoption" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await readRun(ancientRunId)).status).toBe("queued");
    expect(await readIssue(issueId)).toEqual({
      checkoutRunId: null,
      executionRunId: ancientRunId,
    });
  });

  it("does NOT age out a running run that carries no worker-progress signal", async () => {
    // Fail safe: with every progress column null there is nothing to measure,
    // so the run keeps the lock rather than being guessed dead off createdAt.
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const signallessRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: null,
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, signallessRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "No progress signal means no verdict" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await readRun(signallessRunId)).status).toBe("running");
  });

  // ── Two live runs of one agent still cannot both own the issue ────────────

  it("refuses a second live run of the same agent while the first still holds the execution lock", async () => {
    // The failure mode the age-out must not open up. The existing suite covers
    // this for checkoutRunId; this is the executionRunId-only shape, which is
    // the one the age-out path touches.
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const siblingRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: recentAt(),
      processStartedAt: recentAt(),
      lastOutputAt: recentAt(),
      createdAt: recentAt(),
      updatedAt: recentAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, siblingRunId);

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Sibling run must not stomp the holder" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await readRun(siblingRunId)).status).toBe("running");
    expect(await readIssue(issueId)).toEqual({
      checkoutRunId: null,
      executionRunId: siblingRunId,
    });
  });

  it("serialises two concurrent adopters of the same aged-out lock", async () => {
    // Both actors race the same dead run. Exactly one may end up owning the
    // issue; the FOR UPDATE row lock plus the guarded adoption WHERE decide it.
    const { companyId, agentId, currentRunId } = await seedCompanyAndAgent();
    const secondRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
    });
    const deadRunId = await insertRun({
      companyId,
      agentId,
      status: "running",
      startedAt: agedAt(),
      processStartedAt: agedAt(),
      lastOutputAt: agedAt(),
      createdAt: agedAt(),
      updatedAt: agedAt(),
    });
    const issueId = await insertFencedIssue(companyId, agentId, deadRunId);
    // The cross-issue influence gate refuses an agent write whose run carries
    // no source issue, so the actor run names this issue, exactly as the
    // surrounding cases do. Same-issue writes short-circuit the cap.
    for (const runId of [currentRunId, secondRunId]) {
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, runId));
    }

    const [first, second] = await Promise.all([
      request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Adopter one" }),
      request(createApp(agentActor(companyId, agentId, secondRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Adopter two" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await readIssue(issueId);
    const winner = first.status === 200 ? currentRunId : secondRunId;
    expect(row).toEqual({ checkoutRunId: winner, executionRunId: winner });
  });
});
