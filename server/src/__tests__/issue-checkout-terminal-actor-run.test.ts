import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-actor checkout tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// The read side of the checkout lock treats a terminal-or-missing run as
// holding no claim: `clearCheckoutRunIfTerminal` erases such a claim at the
// head of every checkout/ownership request, and `adoptUnownedCheckoutRun`
// refuses to hand the freed lock to a terminal caller. The write side used to
// disagree — the checkout route's own UPDATEs gated on issue status, assignee
// and the two lock columns, never on whether the *caller's* run was still
// alive. A terminal run therefore got `200` with its id in `checkoutRunId`, and
// the next request swept it back to null and answered `409` with every
// ownership column null and no competing run: a state that reads like a lost
// transaction and is really two correct halves disagreeing.
//
// These tests pin the write side to the read side. The load-bearing assertion
// is on the **re-read**, not on the response body — a claim that only survives
// until the next request is the defect, and the response body alone cannot see
// it.
describeEmbeddedPostgres("issue checkout with a terminal actor run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-terminal-actor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
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

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

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

    return { companyId, agentId };
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const runId = randomUUID();
    const terminal = status !== "queued" && status !== "running";
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: status as never,
      invocationSource: "assignment",
      startedAt: new Date(),
      ...(terminal ? { finishedAt: new Date() } : {}),
    });
    return runId;
  }

  async function seedIssue(
    companyId: string,
    values: Partial<typeof issues.$inferInsert> & { title: string },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      status: "todo",
      priority: "high",
      ...values,
    });
    return issueId;
  }

  function readLocks(issueId: string) {
    return db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  function checkout(app: express.Express, issueId: string, agentId: string) {
    return request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] });
  }

  // Criterion 1 — every terminal status, not only the `failed` one the field
  // report carried. All five are in TERMINAL_HEARTBEAT_RUN_STATUSES, so all
  // five are swept by clearCheckoutRunIfTerminal and must all be refused.
  it.each(["failed", "cancelled", "timed_out", "succeeded", "interrupted"])(
    "refuses checkout and persists no claim when the actor run is %s",
    async (runStatus) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const actorRunId = await seedRun(companyId, agentId, runStatus);
      const issueId = await seedIssue(companyId, {
        title: `Terminal actor: ${runStatus}`,
        status: "todo",
        assigneeAgentId: agentId,
      });

      const res = await checkout(createApp(agentActor(companyId, agentId, actorRunId)), issueId, agentId);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({
        error: "Issue checkout conflict",
        code: "actor_run_terminal",
        details: { actorRunId, actorRunStatus: runStatus },
      });
      expect(String(res.body?.details?.reason)).toContain(runStatus);

      // The point of the bug: before the fix this row carried actorRunId.
      expect(await readLocks(issueId)).toEqual({
        status: "todo",
        assigneeAgentId: agentId,
        checkoutRunId: null,
        executionRunId: null,
      });
    },
  );

  it("refuses checkout and persists no claim when the actor run row is missing", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const actorRunId = randomUUID();
    const issueId = await seedIssue(companyId, {
      title: "Missing actor run",
      status: "todo",
      assigneeAgentId: agentId,
    });

    const res = await checkout(createApp(agentActor(companyId, agentId, actorRunId)), issueId, agentId);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
      code: "actor_run_terminal",
      details: { actorRunId, actorRunStatus: "missing" },
    });
    expect(await readLocks(issueId)).toEqual({
      status: "todo",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  // Criterion 1's sibling on the other route: the field report's 409 came from
  // a PATCH, whose body showed nobody owning the issue. Same refusal, now with
  // the reason attached.
  it("names the terminal actor run on an ownership conflict from a mutating route", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const actorRunId = await seedRun(companyId, agentId, "failed");
    const issueId = await seedIssue(companyId, {
      title: "Unowned issue, terminal actor",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be refused with a reason" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue run ownership conflict",
      code: "actor_run_terminal",
      details: { actorRunId, actorRunStatus: "failed", checkoutRunId: null, executionRunId: null },
    });
  });

  // Criterion 2 — the regression the bug defeats. Assert on the re-read.
  it("persists a claim that survives the next request when the actor run is live", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const actorRunId = await seedRun(companyId, agentId, "running");
    const issueId = await seedIssue(companyId, {
      title: "Live actor checkout",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, actorRunId));

    const res = await checkout(app, issueId, agentId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readLocks(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
    });

    // The erase happened on the *next* request, so the re-read has to survive
    // one. A mutating route runs both `clear*IfTerminal` sweeps first.
    // The cross-issue influence gate refuses an agent write whose run carries
    // no source issue, so the actor run names this issue, exactly as the
    // surrounding cases do. Same-issue writes short-circuit the cap.
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, actorRunId));

    const followUp = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Still owned after a second request" });
    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(await readLocks(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
    });
  });

  // Criterion 3 — the adoption paths still work for a live run. This one goes
  // through the unowned-adoption branch, which now delegates to
  // `adoptUnownedCheckoutRun` instead of carrying its own weaker copy.
  it("lets a live actor run adopt an unowned in_progress checkout", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const actorRunId = await seedRun(companyId, agentId, "running");
    const issueId = await seedIssue(companyId, {
      title: "Unowned in_progress checkout",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });

    const res = await checkout(createApp(agentActor(companyId, agentId, actorRunId)), issueId, agentId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: issueId, checkoutRunId: actorRunId });
    // Every other checkout branch returns a label-enriched row; this one used
    // to return the bare row.
    expect(res.body).toHaveProperty("labels");
    expect(await readLocks(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
    });
  });

  it("lets a live actor run take over a checkout held by a terminal run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const deadRunId = await seedRun(companyId, agentId, "failed");
    const actorRunId = await seedRun(companyId, agentId, "running");
    const issueId = await seedIssue(companyId, {
      title: "Stale checkout takeover",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: deadRunId,
      executionRunId: deadRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await checkout(createApp(agentActor(companyId, agentId, actorRunId)), issueId, agentId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readLocks(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
    });
  });

  // Criterion 4 — the property the liveness gate must not weaken. Both runs
  // belong to the same agent and both are live, so nothing here is terminal and
  // no new gate applies; the incumbent keeps the issue.
  it("keeps two concurrently live runs of one agent from both owning the issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const incumbentRunId = await seedRun(companyId, agentId, "running");
    const contenderRunId = await seedRun(companyId, agentId, "running");
    const issueId = await seedIssue(companyId, {
      title: "Two live runs",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: incumbentRunId,
      executionRunId: incumbentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await checkout(createApp(agentActor(companyId, agentId, contenderRunId)), issueId, agentId);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ error: "Issue checkout conflict" });
    // The contender is live, so the refusal is an ownership conflict and must
    // not be reported as a dead-actor refusal.
    expect(res.body?.code).toBeUndefined();
    expect(await readLocks(issueId)).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: incumbentRunId,
      executionRunId: incumbentRunId,
    });

    // The cross-issue influence gate refuses an agent write whose run carries
    // no source issue, so the actor run names this issue, exactly as the
    // surrounding cases do. Same-issue writes short-circuit the cap.
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, incumbentRunId));

    const incumbentWrite = await request(createApp(agentActor(companyId, agentId, incumbentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Incumbent still owns it" });
    expect(incumbentWrite.status, JSON.stringify(incumbentWrite.body)).toBe(200);
  });
});
