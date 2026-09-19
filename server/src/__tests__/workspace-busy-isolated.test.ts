import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Lets one test force a specific agent's invokability check to fail on its
// SECOND call within a single dispatch, without touching the agent's status
// (which would also fail heartbeat.invoke's own upfront gate and never let
// the run reach the busy-deferral path at all). The first call is the
// dispatch-time gate (startNextQueuedRunForAgent); the second is
// finalizeWorkspaceBusyDeferral's own scheduleBoundedRetryForRun call -- the
// two calls this test needs to tell apart.
const forceNotInvokableAfterFirstCall = vi.hoisted(() => ({ agentId: null as string | null, calls: 0 }));
vi.mock("../services/agent-invokability.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-invokability.ts")>(
    "../services/agent-invokability.ts",
  );
  return {
    ...actual,
    evaluateAgentInvokabilityFromDb: async (
      ...args: Parameters<typeof actual.evaluateAgentInvokabilityFromDb>
    ) => {
      const [, agent] = args;
      if (agent?.id && agent.id === forceNotInvokableAfterFirstCall.agentId) {
        forceNotInvokableAfterFirstCall.calls += 1;
        // Empirically (see the call trace this hook was built against),
        // dispatching a fresh invoke() checks invokability twice before the
        // busy gate ever fires (once ahead of the run row, once inside
        // startNextQueuedRunForAgent's own dispatch attempt); the THIRD call
        // is finalizeWorkspaceBusyDeferral's own scheduleBoundedRetryForRun
        // check, which is the one this test forces to fail.
        if (forceNotInvokableAfterFirstCall.calls > 2) {
          return {
            invokable: false,
            reason: "forced_not_invokable_for_test",
            invalidOrgChain: false,
            details: {},
          } as const;
        }
      }
      return actual.evaluateAgentInvokabilityFromDb(...args);
    },
  };
});
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  WORKSPACE_BUSY_ERROR_CODE,
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  WORKSPACE_BUSY_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ISOLATED_BUSY_TEST_ADAPTER = "workspace_busy_isolated_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres isolated-workspace-busy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The shared-workspace deferral gate only ever asked about
// issues.projectWorkspaceId, so two issues that INHERITED the same isolated
// execution workspace — same worktree, one branch, one index — could dispatch
// concurrently and corrupt each other. These tests pin the sibling gate keyed
// on issues.executionWorkspaceId: same ladder, same holder-liveness staleness,
// and unconditional serialization, because "allow" is a coherent policy for a
// shared checkout and is corruption for an inherited worktree.
describeEmbeddedPostgres("isolated-execution-workspace run serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceCwd!: string;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-busy-isolated-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-busy-isolated-"));
    registerServerAdapter({
      type: ISOLATED_BUSY_TEST_ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          resultJson: {},
        };
      },
      testEnvironment: async () => ({
        adapterType: ISOLATED_BUSY_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    // Seeded holder runs are synthetic "running" rows with no real execution
    // behind them; cancel them first so the drain helper does not spin
    // waiting for them to finish.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
    executedRunIds.length = 0;
    forceNotInvokableAfterFirstCall.agentId = null;
    forceNotInvokableAfterFirstCall.calls = 0;
  });

  afterAll(async () => {
    unregisterServerAdapter(ISOLATED_BUSY_TEST_ADAPTER);
    if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  // A deferral does two writes in order: it cancels the original run, then it
  // inserts the scheduled-retry row. waitForRunToLeaveActiveStates returns
  // after the first write, so poll for the second rather than racing it.
  async function waitForRetryRun(originalRunId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, originalRunId))
        .then((rows) => rows[0] ?? null);
      if (retryRun) return retryRun;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, originalRunId))
      .then((rows) => rows[0] ?? null);
  }

  interface IsolatedWorkspaceFixture {
    companyId: string;
    executionWorkspaceId: string;
    holderExecutionWorkspaceId: string;
    holderRunId: string;
    holderIssueId: string;
    agentId: string;
    issueId: string;
  }

  // Both issues carry an executionWorkspaceId, the inheritance shape: issues.ts
  // copies the source issue's executionWorkspaceId onto the child row at
  // CREATION time (with preference "reuse_existing"), so by the time the
  // pre-dispatch gate runs the column is already populated on both. The two
  // issues deliberately sit on DIFFERENT project workspaces so nothing here can
  // be explained by the pre-existing shared-workspace arm.
  async function seedIsolatedWorkspaceFixture(input?: {
    holderSharesExecutionWorkspace?: boolean;
    holderActivityAt?: Date;
    issueWorkspaceSettings?: Record<string, unknown> | null;
    isolatedWorkspacesEnabled?: boolean;
  }): Promise<IsolatedWorkspaceFixture> {
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: input?.isolatedWorkspacesEnabled ?? true,
    });
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const holderProjectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const holderExecutionWorkspaceId = input?.holderSharesExecutionWorkspace === false
      ? randomUUID()
      : executionWorkspaceId;
    const holderAgentId = randomUUID();
    const holderIssueId = randomUUID();
    const holderRunId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Isolated Workspace Busy Project",
    });

    for (const [id, name, isPrimary] of [
      [projectWorkspaceId, "Primary workspace", true],
      [holderProjectWorkspaceId, "Holder workspace", false],
    ] as const) {
      await db.insert(projectWorkspaces).values({
        id,
        companyId,
        projectId,
        name,
        sourceType: "local_path",
        cwd: workspaceCwd,
        isPrimary,
      });
    }

    for (const id of new Set([executionWorkspaceId, holderExecutionWorkspaceId])) {
      await db.insert(executionWorkspaces).values({
        id,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: `Inherited worktree ${id}`,
        status: "active",
        providerType: "local_fs",
        cwd: workspaceCwd,
      });
    }

    for (const [id, name] of [
      [holderAgentId, "HolderCoder"],
      [agentId, "DeferredCoder"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: id === holderAgentId ? "running" : "idle",
        adapterType: ISOLATED_BUSY_TEST_ADAPTER,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      });
    }

    const holderActivityAt = input?.holderActivityAt ?? now;
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: holderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: holderActivityAt,
      lastOutputAt: holderActivityAt,
      contextSnapshot: {
        issueId: holderIssueId,
        wakeReason: "issue_assigned",
      },
      createdAt: holderActivityAt,
      updatedAt: holderActivityAt,
    });

    await db.insert(issues).values({
      id: holderIssueId,
      companyId,
      title: "Holder issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: holderAgentId,
      projectId,
      projectWorkspaceId: holderProjectWorkspaceId,
      executionWorkspaceId: holderExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      executionRunId: holderRunId,
      executionAgentNameKey: "holdercoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Inheriting issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings:
        input?.issueWorkspaceSettings === undefined
          ? { mode: "isolated_workspace" }
          : input.issueWorkspaceSettings,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    return {
      companyId,
      executionWorkspaceId,
      holderExecutionWorkspaceId,
      holderRunId,
      holderIssueId,
      agentId,
      issueId,
    };
  }

  it("defers a run whose issue inherited a busy execution workspace and schedules a bounded retry", async () => {
    const fixture = await seedIsolatedWorkspaceFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);

    // The deferral is diagnosable by the key it actually used: the isolated key
    // is set and the project key is null, so a reader can tell which of the two
    // gates parked the run.
    const workspaceBusy = (finishedRun?.resultJson as Record<string, unknown> | null)
      ?.workspaceBusy as Record<string, unknown> | undefined;
    expect(workspaceBusy).toMatchObject({
      executionWorkspaceId: fixture.executionWorkspaceId,
      projectWorkspaceId: null,
      holderRunId: fixture.holderRunId,
      holderIssueId: fixture.holderIssueId,
      deferralAttempt: 0,
    });
    expect(finishedRun?.error).toContain("Isolated execution workspace is busy");

    // Same ladder as the shared arm, reused verbatim.
    const retryRun = await waitForRetryRun(run!.id);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: run!.id,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });

    // The deferral is not a failure and spends no attempt: the retry starts
    // its own count at 0/1, not incremented off whatever the original run's
    // (unrelated) attempt bookkeeping was.
    expect(finishedRun?.processLossRetryCount ?? 0).toBe(0);

    // The issue execution lock moved to the retry, so the issue keeps an
    // active execution path -- stranded-issue recovery must leave it alone.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBe(retryRun!.id);

    // The agent returned to idle rather than sitting in an error state.
    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status })
            .from(agents)
            .where(eq(agents.id, fixture.agentId))
            .then((rows) => rows[0]?.status ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toBe("idle");
  });

  it("keeps deferring an inherited-workspace run past many attempts while the holder is still live", async () => {
    // The mirror of the shared arm's "no ceiling" test: holder liveness, not
    // an attempt counter, is what bounds this deferral. Seed the promoted
    // continuation of a run already deferred many times.
    const fixture = await seedIsolatedWorkspaceFixture();
    const priorAttempts = 10;
    const priorRunId = randomUUID();
    const wakeupId = randomUUID();
    const retryRunId = randomUUID();
    const now = new Date();
    const dueAt = new Date(now.getTime() - 1_000);

    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: WORKSPACE_BUSY_ERROR_CODE,
      finishedAt: now,
      scheduledRetryAttempt: priorAttempts - 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
      contextSnapshot: { issueId: fixture.issueId, wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
      payload: {
        issueId: fixture.issueId,
        retryOfRunId: priorRunId,
        retryReason: WORKSPACE_BUSY_RETRY_REASON,
        scheduledRetryAttempt: priorAttempts,
      },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: wakeupId,
      retryOfRunId: priorRunId,
      scheduledRetryAt: dueAt,
      scheduledRetryAttempt: priorAttempts,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
      contextSnapshot: {
        issueId: fixture.issueId,
        wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
        retryReason: WORKSPACE_BUSY_RETRY_REASON,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(now);
    expect(promotion.runIds).toContain(retryRunId);

    await heartbeat.resumeQueuedRuns();
    const finishedRun = await waitForRunToLeaveActiveStates(retryRunId);

    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(retryRunId);

    const nextRetry = await waitForRetryRun(retryRunId);
    expect(nextRetry).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: priorAttempts + 1,
      scheduledRetryReason: WORKSPACE_BUSY_RETRY_REASON,
    });

    const holderRun = await heartbeat.getRun(fixture.holderRunId);
    expect(holderRun?.status).toBe("running");
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)(
    "frees the isolated workspace once the holder reaches the terminal state %s",
    async (terminalStatus) => {
      const fixture = await seedIsolatedWorkspaceFixture();
      // Overwrite the holder into the terminal state under test -- a holder
      // that is not "running" is, by every terminal path, no longer live.
      await db
        .update(heartbeatRuns)
        .set({ status: terminalStatus, finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, fixture.holderRunId));

      const run = await heartbeat.invoke(
        fixture.agentId,
        "assignment",
        { issueId: fixture.issueId, wakeReason: "issue_assigned" },
        "system",
      );
      expect(run).not.toBeNull();

      // Mirrors the negative control above ("does not defer when the live
      // holder sits on a different execution workspace"): the fixture's
      // workspace cwd is a bare tmpdir, not a real git worktree, so past the
      // busy gate the run can still fail downstream on workspace validation.
      // The invariant this test owns is only that it was never parked as
      // workspace_busy -- a terminal holder must not gate at all.
      const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
      expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
      expect(finishedRun?.status).not.toBe("cancelled");
      const busyRetries = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(busyRetries).toHaveLength(0);
    },
  );

  it("releases the issue execution lock when the deferred run's retry cannot be scheduled", async () => {
    // finalizeWorkspaceBusyDeferral's own scheduleBoundedRetryForRun call gates
    // on getAgentInvokability -- not an attempt ceiling, which this arm does
    // not have. The spec's scenario (spec.md: "no retry could be scheduled,
    // because its agent is no longer invokable") is the agent becoming
    // non-invokable BETWEEN dispatch and the retry-scheduling step; simply
    // terminating the agent up front instead fails heartbeat.invoke's own
    // upfront gate and the run never reaches the busy check at all. The
    // forced-invokability hook stands in for that race deterministically.
    const fixture = await seedIsolatedWorkspaceFixture();
    forceNotInvokableAfterFirstCall.agentId = fixture.agentId;
    forceNotInvokableAfterFirstCall.calls = 0;

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);

    // No BOUNDED WORKSPACE-BUSY retry was scheduled for it -- the ladder
    // this arm shares with the shared arm did not fire, because
    // scheduleBoundedRetryForRun's own invokability gate refused it.
    const busyRetries = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, run!.id),
          eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
        ),
      );
    expect(busyRetries).toHaveLength(0);

    // The issue does not strand on the cancelled run: releaseIssueExecutionAndPromote's
    // own (separate, status-based) invokability read is untouched by the
    // forced hook, so it still promotes a live path for the issue rather than
    // abandoning it -- exactly the "SHALL NOT strand" half of the scenario.
    // The invariant this test owns is that the lock moved OFF the dead run.
    const issueRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).not.toBe(run!.id);
  });

  it("serializes an inherited worktree even when the issue policy says allow", async () => {
    // sharedWorkspaceConcurrency is deliberately NOT consulted by the isolated
    // arm. "allow" means "coordinate via commits", which is a real protocol on
    // a shared checkout and nonsense in a worktree with one branch and one
    // index — so the policy that would dispatch on the shared arm still defers
    // here.
    const fixture = await seedIsolatedWorkspaceFixture({
      issueWorkspaceSettings: { mode: "isolated_workspace", sharedWorkspaceConcurrency: "allow" },
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);
    // The shared arm's concurrent-dispatch note must be unreachable from here.
    expect(
      (finishedRun?.contextSnapshot as Record<string, unknown> | null)?.paperclipTaskMarkdown ?? "",
    ).not.toContain("expect concurrent mutations, coordinate via commits");
  });

  it("defers on an inherited worktree with the isolated-workspaces flag off", async () => {
    // The state the fleet is actually in. `enableIsolatedWorkspaces` governs
    // how a workspace is REQUESTED -- with it off the issue settings are
    // dropped, the project policy is gated, and every run resolves to a
    // non-isolated mode -- but it does not unbind the workspace: issues.
    // execution_workspace_id and the "reuse_existing" preference were written
    // at issue creation and are still there, still pointing both issues at one
    // worktree. A gate keyed on the mode would therefore be dead in exactly
    // the configuration that ships, which is why this one is keyed on the id.
    const fixture = await seedIsolatedWorkspaceFixture({ isolatedWorkspacesEnabled: false });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.errorCode).toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(executedRunIds).not.toContain(run!.id);

    // Keyed on the isolated id, not on the project workspace: the two issues
    // deliberately sit on different project workspaces, so the shared arm
    // cannot account for this deferral.
    const workspaceBusy = (finishedRun?.resultJson as Record<string, unknown> | null)
      ?.workspaceBusy as Record<string, unknown> | undefined;
    expect(workspaceBusy).toMatchObject({
      executionWorkspaceId: fixture.executionWorkspaceId,
      projectWorkspaceId: null,
      holderRunId: fixture.holderRunId,
    });
  });

  it("does not defer when the live holder sits on a different execution workspace", async () => {
    // The negative control for the key itself. The holder is live and isolated,
    // but it is a different worktree, so it is not this run's problem. The run
    // may still fail downstream for unrelated reasons in this fixture — the
    // invariant under test is only that it was not parked as workspace_busy.
    const fixture = await seedIsolatedWorkspaceFixture({ holderSharesExecutionWorkspace: false });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    // A deferral cancels the run; anything else means the gate let it through.
    expect(finishedRun?.status).not.toBe("cancelled");
    const busyRetries = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON));
    expect(busyRetries).toHaveLength(0);
  });

  it("does not defer behind a holder that has been silent past the staleness window", async () => {
    // Holder liveness, not an attempt counter, is what bounds this deferral —
    // the same WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS window the shared arm uses.
    // A zombie holder must not park an inheriting issue forever.
    const fixture = await seedIsolatedWorkspaceFixture({
      holderActivityAt: new Date(Date.now() - WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS - 60_000),
    });

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.errorCode).not.toBe(WORKSPACE_BUSY_ERROR_CODE);
    expect(finishedRun?.status).not.toBe("cancelled");
  });
});
