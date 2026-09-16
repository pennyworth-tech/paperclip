import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Never-started execution lock guard test run.",
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
    `Skipping embedded Postgres never-started execution lock guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The legacy-run reconciliation in enqueueWakeup installs whatever non-terminal
// run names this issue in its contextSnapshot as the execution lock holder. An
// `@`-mention enqueues a `queued` run for a third agent and takes no checkout,
// so that run is never claimed, never starts, and never reaches a terminal
// status — and `clearExecutionRunIfTerminal` therefore keeps it forever. The
// guard directly above the legacy block already refuses exactly this holder
// ("stale by design ... will never run") when it is already installed; these
// tests pin that the block below no longer re-installs it, and that the
// assignee's own not-yet-claimed run is still installed so a repeat wake
// coalesces instead of enqueuing a duplicate run.
//
// The third test pins the other half: the block also stamped the lock for a
// *live* foreign run, which is how a plain comment re-armed the fence on an
// issue whose lock had just been released — even a `done` one. Deferral and
// lock ownership are separated there, so the live run still parks the incoming
// wake while the lock stays null.
describeEmbeddedPostgres("enqueueWakeup legacy execution lock candidate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-never-started-lock-guard-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    // A wake that enqueues also starts the run; let the mocked execution finish
    // before the fixture is torn out from under it, then cascade the whole
    // company away rather than chasing every table the finished run wrote to.
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE;`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedNeverStartedCandidate(opts: {
    candidateIsAssignee: boolean;
    candidateStatus?: "queued" | "running";
    issueStatus?: "in_progress" | "done";
  }) {
    const candidateStatus = opts.candidateStatus ?? "queued";
    const issueStatus = opts.issueStatus ?? "in_progress";
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const candidateRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const ownerUserId = `owner-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });

    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: mentionedAgentId,
        companyId,
        name: "Mentioned",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const candidateAgentId = opts.candidateIsAssignee ? assigneeAgentId : mentionedAgentId;

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: candidateAgentId,
      source: "automation",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: candidateRunId,
      companyId,
      agentId: candidateAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: candidateStatus,
      // `queued` leaves startedAt null — that run was never claimed. `running`
      // is the live foreign mention run: it did start, so no staleness
      // predicate can touch it, and it must still defer the assignee's wake.
      startedAt: candidateStatus === "running" ? new Date() : undefined,
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_comment_mentioned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Never-started candidate for the execution lock",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId,
      // Lazy locking: a queued run does not stamp the lock at queue time.
      executionRunId: null,
      checkoutRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, assigneeAgentId, mentionedAgentId, issueId, candidateRunId };
  }

  it("does not install a never-started queued run owned by a non-assignee", async () => {
    const { assigneeAgentId, issueId, candidateRunId } = await seedNeverStartedCandidate({
      candidateIsAssignee: false,
    });

    const wokenRun = await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // Before the guard the mention run was installed as the holder and this wake
    // was parked in `deferred_issue_execution` — forever, because a never-claimed
    // queued run never reaches a terminal status.
    expect(wokenRun).not.toBeNull();
    expect(wokenRun?.agentId).toBe(assigneeAgentId);

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).not.toBe(candidateRunId);

    const deferred = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, assigneeAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(deferred).toHaveLength(0);

    // The other agent's backlogged run is left alone — this refuses to install
    // it, it does not cancel it.
    const candidate = await db
      .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, candidateRunId))
      .then((rows) => rows[0] ?? null);
    expect(candidate?.status).toBe("queued");
    expect(candidate?.finishedAt).toBeNull();
  });

  it("still installs the assignee's own never-started queued run so a repeat wake coalesces", async () => {
    const { assigneeAgentId, issueId, candidateRunId } = await seedNeverStartedCandidate({
      candidateIsAssignee: true,
    });

    await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // The issue leg of enqueueWakeup dedupes only through the execution lock
    // holder, so refusing to install the assignee's own queued run here would
    // enqueue a second run for the same agent on the same issue.
    const assigneeRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, assigneeAgentId));
    expect(assigneeRuns.map((row) => row.id)).toEqual([candidateRunId]);
  });

  it("defers to a live foreign run without handing it the lock, so a comment on a done issue leaves executionRunId null", async () => {
    const { assigneeAgentId, issueId, candidateRunId } = await seedNeverStartedCandidate({
      candidateIsAssignee: false,
      candidateStatus: "running",
      issueStatus: "done",
    });

    const wakeCommentId = randomUUID();
    const wokenRun = await heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: wakeCommentId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // The lock is the assertion that matters. `executionRunId` is what
    // assertCheckoutOwner fences on, so re-arming it from a comment is what made
    // a released lock refuse to stay released and `done` an unsafe resting state
    // for a recovered issue. A mention run is not the assignee and never owns it
    // — the claim-time stamp in claimQueuedRun has always said so.
    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionAgentNameKey).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();

    // The serialization the stamp used to carry is unchanged: a live foreign run
    // is still an active execution for this issue, so the wake parks instead of
    // putting a second run on the issue's branch. Dropping this would trade the
    // fence for double execution.
    expect(wokenRun).toBeNull();
    const deferred = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, assigneeAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(deferred).toHaveLength(1);

    // The live run keeps running; this refuses it the lock, it does not cancel
    // it. Its own finalize promotes the parked wake off its context issue, which
    // admits a null executionRunId explicitly.
    const candidate = await db
      .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, candidateRunId))
      .then((rows) => rows[0] ?? null);
    expect(candidate?.status).toBe("running");
    expect(candidate?.finishedAt).toBeNull();

    // ---- the resume half of the same trade --------------------------------
    //
    // Everything above only says the wake was parked and the stamp refused.
    // That is an improvement on re-arming the fence *only* if the parked wake
    // still resumes once the foreign run ends. If it does not, this patch
    // trades a transient fence for a permanently parked wake, which is
    // strictly worse than the bug it fixes — so the deferral and the promotion
    // are pinned here as one trade rather than in a separate test.
    //
    // Promotion in releaseIssueExecutionAndPromote is keyed on issue identity,
    // never on the lock column: the candidate scan finds the context issue by
    // `issues.id` disjoined with (not gated on) the lock columns, the
    // ownership guard is `issue.executionRunId && issue.executionRunId !==
    // run.id` so a null lock short-circuits past it, and the deferred scan
    // matches `payload ->> 'issueId'`. A null lock is therefore promotable by
    // construction. Re-key any one of those three on executionRunId and this
    // wake strands forever with nothing else in the suite noticing.

    // startNextQueuedRunForAgent starts the promoted run for real, and the
    // default adapter mock resolves immediately — so without a gate the
    // promoted run can finish and its own finalize can clear the lock again
    // before the assertions below read it. Hold it inside execute().
    let releasePromotedRun = () => {};
    const promotedRunHeld = new Promise<void>((resolve) => {
      releasePromotedRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await promotedRunHeld;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Promoted deferred wake.",
        provider: "test",
        model: "test-model",
      };
    });

    // Terminal through a real finalize path, not an UPDATE: cancelRun is the
    // public entry point that reaches releaseIssueExecutionAndPromote for a
    // `running` run.
    await heartbeat.cancelRun(candidateRunId, "Foreign mention run finished");

    try {
      // The parked agent had no run of its own — the seeded candidate belongs
      // to the mentioned agent — so any run here is the promoted one.
      const promotedRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, assigneeAgentId));
      expect(promotedRuns).toHaveLength(1);
      const promotedRunId = promotedRuns[0]?.id ?? null;
      expect(promotedRunId).not.toBeNull();

      // It left deferred_issue_execution: the park was drained, not abandoned.
      const stillDeferred = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, assigneeAgentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        );
      expect(stillDeferred).toHaveLength(0);

      // ...and it left as *this* run, so the wake resumed rather than being
      // failed or cancelled out of the queue.
      const promotedWakeup = await db
        .select({ runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, assigneeAgentId))
        .then((rows) => rows[0] ?? null);
      expect(promotedWakeup?.runId).toBe(promotedRunId);

      // The lock lands with the assignee instead of staying null forever. This
      // is the assertion that fails if promotion is ever re-keyed on the lock
      // column: with executionRunId null there would be no promoted run to
      // point at and this would still read null.
      const promotedIssue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(promotedIssue?.executionRunId).toBe(promotedRunId);
      expect(promotedIssue?.executionAgentNameKey).toBe("assignee");
      expect(promotedIssue?.executionLockedAt).not.toBeNull();
    } finally {
      releasePromotedRun();
    }
  });
});
