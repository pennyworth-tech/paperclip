import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Queued-run starvation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-run starvation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Must exceed the 30-minute QUEUED_RUN_STARVATION_CEILING_DEFAULT_MS in
// heartbeat.ts. The tests backdate createdAt rather than injecting the constant,
// so they exercise the shipped default.
const PAST_CEILING_MS = 31 * 60 * 1000;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat queued-run starvation ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queued-run-starvation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Queued-run starvation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(companyId: string, agentId: string, maxConcurrentRuns: number) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QueueAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns,
        },
      },
      permissions: {},
    });
  }

  // Insert an assigned todo issue plus a queued assignment run for it, exactly
  // the shape the dispatcher produces for an `issue_assigned` wake. `createdAt`
  // is explicit so a test can backdate a run past the starvation ceiling.
  async function seedQueuedAssignmentRun(input: {
    companyId: string;
    agentId: string;
    title: string;
    priority: "critical" | "high" | "medium" | "low";
    createdAt: Date;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "todo",
      priority: input.priority,
      assigneeAgentId: input.agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      createdAt: input.createdAt,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId,
      authorAgentId: input.agentId,
      authorType: "agent",
      createdByRunId: runId,
      body: `${input.title} run completed.`,
    });
    return { issueId, runId };
  }

  async function readRun(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  // Criterion 4: below the ceiling, priority still decides. This is the control
  // for the starvation test — same shape, no backdating.
  it("still serves a higher-priority run first when neither run has reached the ceiling", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedCompanyAndAgent(companyId, agentId, 1);

    const now = Date.now();
    const medium = await seedQueuedAssignmentRun({
      companyId,
      agentId,
      title: "Fresh medium assignment",
      priority: "medium",
      // Older, but nowhere near the ceiling, so priority must still win.
      createdAt: new Date(now - 60_000),
    });
    const high = await seedQueuedAssignmentRun({
      companyId,
      agentId,
      title: "Fresh high assignment",
      priority: "high",
      createdAt: new Date(now),
    });

    await heartbeat.resumeQueuedRuns();

    const bothFinished = await waitForCondition(async () => {
      const [mediumRun, highRun] = await Promise.all([readRun(medium.runId), readRun(high.runId)]);
      return mediumRun?.status === "succeeded" && highRun?.status === "succeeded";
    }, 30_000);
    expect(bothFinished).toBe(true);

    const [mediumRun, highRun] = await Promise.all([readRun(medium.runId), readRun(high.runId)]);
    expect(highRun?.startedAt).toBeTruthy();
    expect(mediumRun?.startedAt).toBeTruthy();
    expect(highRun!.startedAt!.getTime()).toBeLessThan(mediumRun!.startedAt!.getTime());
  }, 60_000);

  // Criterion 1 + 3: the starvation reproduction. A single-slot agent with a
  // continuous stream of higher-priority arrivals served the medium tier NEVER,
  // not slowly, because createdAt was only the third sort key and there was no
  // aging term. The escalation must serve the older run despite fresh, queued,
  // higher-priority work.
  it("serves a queued run that passed the ceiling while higher-priority runs keep arriving", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedCompanyAndAgent(companyId, agentId, 1);

    const now = Date.now();
    const starved = await seedQueuedAssignmentRun({
      companyId,
      agentId,
      title: "Starved medium assignment",
      priority: "medium",
      createdAt: new Date(now - PAST_CEILING_MS),
    });

    const highRunIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const seeded = await seedQueuedAssignmentRun({
        companyId,
        agentId,
        title: `Seeded high assignment ${index}`,
        priority: "high",
        createdAt: new Date(now - 1_000 + index),
      });
      highRunIds.push(seeded.runId);
    }

    // The arrival stream: every time the agent services a run, one more fresh
    // `high` lands behind it, and the stream keeps going for as long as the
    // starved run has not started. Without it the queue drains and the medium is
    // served by attrition rather than by the fix. MAX_ARRIVALS is only a
    // termination guard for the test harness — the stream stops on its own the
    // moment the starved run is served.
    const MAX_ARRIVALS = 20;
    let arrivals = 0;
    // How many runs the agent serviced before the starved run got its turn. This
    // is the bound criterion 1 asks for, made concrete.
    let servicesBeforeStarvedStart = 0;
    mockAdapterExecute.mockImplementation(async () => {
      const starvedRun = await readRun(starved.runId);
      if (!starvedRun?.startedAt) servicesBeforeStarvedStart += 1;
      if (!starvedRun?.finishedAt && arrivals < MAX_ARRIVALS) {
        arrivals += 1;
        const arrival = await seedQueuedAssignmentRun({
          companyId,
          agentId,
          title: `Arriving high assignment ${arrivals}`,
          priority: "high",
          createdAt: new Date(),
        });
        highRunIds.push(arrival.runId);
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Queued-run starvation test run.",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();

    const starvedServed = await waitForCondition(async () => {
      const run = await readRun(starved.runId);
      return run?.status === "succeeded";
    }, 45_000);
    expect(starvedServed).toBe(true);

    const starvedRun = await readRun(starved.runId);
    expect(starvedRun?.startedAt).toBeTruthy();
    const starvedStartedMs = starvedRun!.startedAt!.getTime();

    // The stream really did keep arriving, and at the moment the starved run was
    // served there was fresher higher-priority work already queued that got
    // passed over. This is the assertion that separates "served" from "served
    // only once the higher-priority work happened to run out".
    expect(arrivals).toBeGreaterThan(0);
    const highRuns = await Promise.all(highRunIds.map((runId) => readRun(runId)));
    const passedOver = highRuns.filter((run) =>
      run !== null
      && run.createdAt.getTime() < starvedStartedMs
      && (run.startedAt === null || run.startedAt.getTime() > starvedStartedMs));
    expect(passedOver.length).toBeGreaterThan(0);
    // Past the ceiling the wait is bounded: the starved run goes to the front and
    // is served on the next selection pass, not after the stream exhausts.
    expect(servicesBeforeStarvedStart).toBeLessThanOrEqual(1);
  }, 90_000);

  // Criterion 2: a run that can never be claimed must become terminal without
  // depending on selection. A dependency-blocked run sorts rank 3 — dead last —
  // so with one slot it was never selected, never cancelled, never terminal, and
  // held its issue's executionRunId forever.
  it("cancels a permanently-blocked queued run below the slot budget and releases its execution lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    await seedCompanyAndAgent(companyId, agentId, 1);

    // The single slot is held for the duration of the assertions. Without this
    // the queue drains, the blocked run is selected by attrition, and the test
    // stops reproducing the leak — the production shape is an agent whose
    // execution chain is gapless, so the rank-3 tail is never reached.
    let releaseHoldingRun!: () => void;
    const holdingRunReleased = new Promise<void>((resolve) => {
      releaseHoldingRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await holdingRunReleased;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Holding run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Unresolved blocker",
      status: "todo",
      priority: "high",
      responsibleUserId: "responsible-user",
    });

    const now = Date.now();
    const blocked = await seedQueuedAssignmentRun({
      companyId,
      agentId,
      title: "Blocked assignment",
      priority: "high",
      createdAt: new Date(now - 120_000),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blocked.issueId,
      type: "blocks",
    });
    // The leak itself: the blocked issue's execution lock is held by its own
    // never-started queued run.
    await db
      .update(issues)
      .set({
        status: "blocked",
        executionRunId: blocked.runId,
        executionAgentNameKey: "queue-agent",
        executionLockedAt: new Date(now - 120_000),
      })
      .where(eq(issues.id, blocked.issueId));

    // The holder takes the single slot, and a second ready run sits behind it,
    // so selection never reaches the rank-3 blocked run.
    const holding = await seedQueuedAssignmentRun({
      companyId,
      agentId,
      title: "Holding assignment",
      priority: "high",
      createdAt: new Date(now - 60_000),
    });
    const waiting = await seedQueuedAssignmentRun({
      companyId,
      agentId,
      title: "Waiting assignment",
      priority: "high",
      createdAt: new Date(now),
    });

    try {
      await heartbeat.resumeQueuedRuns();

      const holdingStarted = await waitForCondition(async () => {
        const run = await readRun(holding.runId);
        return run?.status === "running";
      }, 30_000);
      expect(holdingStarted).toBe(true);

      // The blocked run must be resolved while the slot is still held, without
      // ever being selected.
      const blockedTerminal = await waitForCondition(async () => {
        const run = await readRun(blocked.runId);
        return run?.status === "cancelled";
      }, 30_000);
      expect(blockedTerminal).toBe(true);

      const [blockedRun, holdingRun, waitingRun] = await Promise.all([
        readRun(blocked.runId),
        readRun(holding.runId),
        readRun(waiting.runId),
      ]);
      expect(holdingRun?.status).toBe("running");
      expect(waitingRun?.status).toBe("queued");
      expect(blockedRun?.status).toBe("cancelled");
      expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
      expect(blockedRun?.startedAt).toBeNull();
      expect(blockedRun?.finishedAt).toBeTruthy();

      const blockedIssue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blocked.issueId))
        .then((rows) => rows[0] ?? null);
      expect(blockedIssue).toMatchObject({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });
    } finally {
      releaseHoldingRun();
    }

    const drained = await waitForCondition(async () => {
      const [holdingRun, waitingRun] = await Promise.all([
        readRun(holding.runId),
        readRun(waiting.runId),
      ]);
      return holdingRun?.status === "succeeded" && waitingRun?.status === "succeeded";
    }, 30_000);
    expect(drained).toBe(true);
  }, 60_000);
});
