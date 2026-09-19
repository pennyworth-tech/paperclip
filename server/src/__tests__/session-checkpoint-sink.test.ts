import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  SESSION_CHECKPOINT_EVENT_TYPE as ADAPTER_SIDE_SESSION_CHECKPOINT_EVENT_TYPE,
  type SessionCheckpointPayload,
} from "@paperclipai/adapter-utils/session-checkpoint";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const CHECKPOINT_TEST_ADAPTER = "session_checkpoint_test";
// Duplicated from the adapter side on purpose — this literal is a wire
// contract between the harness and the host sink, and the test asserts the
// contract rather than re-importing one half of it.
const SESSION_CHECKPOINT_EVENT_TYPE = "session.checkpoint";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session-checkpoint tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A run killed mid-flight never reaches the finalization upsert, so before the
// checkpoint sink existed the harness session it had minted was simply lost and
// the retry started cold. These tests pin the two halves of the contract: the
// checkpoint is persisted the moment it arrives, and the run's own final result
// stays authoritative over it.
describeEmbeddedPostgres("mid-run session checkpoint sink", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let adapterBehavior: (input: AdapterExecutionContext) => Promise<AdapterExecutionResult> = async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-session-checkpoint-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: CHECKPOINT_TEST_ADAPTER,
      execute: async (input) => adapterBehavior(input),
      testEnvironment: async () => ({
        adapterType: CHECKPOINT_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
  });

  afterAll(async () => {
    unregisterServerAdapter(CHECKPOINT_TEST_ADAPTER);
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
    await db.delete(heartbeatRunEvents);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
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

  async function readTaskSession(agentId: string) {
    return await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  // The issue id IS the task key (deriveTaskKey falls through to issueId), so
  // seeding an assigned issue is all it takes to give the run a task session to
  // write. No project or workspace: the agent runs in its own default mode, so
  // nothing here depends on workspace realization.
  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CheckpointCoder",
      role: "engineer",
      status: "idle",
      adapterType: CHECKPOINT_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkpoint issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  // The run row reaches a terminal status BEFORE the task-session upsert runs,
  // so reading the session straight after waitForRunToLeaveActiveStates races
  // the write under test. drainActiveRunExecutions awaits the execution itself,
  // which is the only point at which the session row is settled.
  // skipIssueComment keeps the must-comment policy from queueing a follow-up
  // wake, whose own run would write the session row a second time.
  async function invokeAndSettle(agentId: string, issueId: string, wakeReason = "issue_assigned") {
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason, skipIssueComment: true },
      "system",
    );
    expect(run).not.toBeNull();
    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    await heartbeat.drainActiveRunExecutions();
    return finishedRun;
  }

  it("persists a mid-run checkpoint even when the adapter then throws", async () => {
    // The whole reason the sink exists. The adapter mints a session, tells us
    // about it, and is then killed — finalization never runs with a result, so
    // the checkpoint is the only record of the session that was in flight.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        stream: "system",
        level: "info",
        payload: {
          attempt: 1,
          sessionId: "checkpointed-session",
          sessionParams: { sessionId: "checkpointed-session" },
        },
      });
      throw new Error("harness was killed mid-run");
    };

    const finishedRun = await invokeAndSettle(agentId, issueId);
    expect(finishedRun?.status).toBe("failed");

    const taskSession = await readTaskSession(agentId);
    expect(taskSession?.taskKey).toBe(issueId);
    expect(taskSession?.sessionDisplayId).toBe("checkpointed-session");
    expect(taskSession?.sessionParamsJson).toMatchObject({ sessionId: "checkpointed-session" });

    // The event is observed, not swallowed: the run log still carries it.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, finishedRun!.id));
    expect(events.some((row) => row.eventType === SESSION_CHECKPOINT_EVENT_TYPE)).toBe(true);
  });

  it("does not write the pre-dispatch session back over a checkpoint when the adapter throws", async () => {
    // The actual defect on the adapter-threw path, and the only test here that
    // discriminates it: the run RESUMED an existing session, rotated to a new
    // one mid-flight, and was then killed. `previousSessionParams` is the
    // snapshot taken before dispatch, so writing it back — which is what that
    // path used to do unconditionally — strands the new session and sends the
    // retry back to the one the harness had already left behind.
    const { companyId, agentId, issueId } = await seedFixture();
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: CHECKPOINT_TEST_ADAPTER,
      taskKey: issueId,
      sessionParamsJson: { sessionId: "old-session" },
      sessionDisplayId: "old-session",
      lastRunId: null,
      lastError: null,
    });
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "rotated-session",
          sessionParams: { sessionId: "rotated-session" },
        },
      });
      throw new Error("harness was killed mid-run");
    };

    await invokeAndSettle(agentId, issueId);

    const taskSession = await readTaskSession(agentId);
    expect(taskSession?.sessionDisplayId).toBe("rotated-session");
    expect(taskSession?.sessionParamsJson).toMatchObject({ sessionId: "rotated-session" });
  });

  it("stores the checkpoint with config-fingerprint metadata so the next wake does not reset it", async () => {
    // Not cosmetic. resolveTaskSessionConfigFreshness reads the stored
    // fingerprint back and treats its absence as "configuration metadata is
    // missing" — which resets the session. A checkpoint written without the
    // metadata would therefore be discarded on the very retry it exists to
    // serve, while still looking correct in the row.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "fingerprinted-session",
          sessionParams: { sessionId: "fingerprinted-session" },
        },
      });
      throw new Error("harness was killed mid-run");
    };

    await invokeAndSettle(agentId, issueId);

    const params = (await readTaskSession(agentId))?.sessionParamsJson as Record<string, unknown> | null;
    expect(params?.sessionId).toBe("fingerprinted-session");
    expect(typeof params?.__paperclipConfigFingerprint).toBe("string");
    expect(params?.__paperclipConfigFingerprintVersion).toBeDefined();
  });

  it("lets the adapter's own result overwrite the checkpoint it wrote earlier", async () => {
    // The checkpoint is provisional. A run that checkpoints one session and
    // then finishes on another — a rotation — must leave the FINAL one behind,
    // or the next wake resumes a session the harness already abandoned.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "provisional-session",
          sessionParams: { sessionId: "provisional-session" },
        },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "final-session" },
        sessionDisplayId: "final-session",
        summary: "Rotated to a new session before finishing.",
      };
    };

    const finishedRun = await invokeAndSettle(agentId, issueId);
    expect(finishedRun?.status).toBe("succeeded");

    const taskSession = await readTaskSession(agentId);
    expect(taskSession?.sessionDisplayId).toBe("final-session");
    expect(taskSession?.sessionParamsJson).toMatchObject({ sessionId: "final-session" });
  });

  it("lets the adapter clear a session it had already checkpointed", async () => {
    // The clearSession signal — how claude's poison guard drops an unusable id
    // — has to win over the checkpoint too. Otherwise the checkpoint would
    // resurrect exactly the session the adapter just declared poisoned.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "poisoned-session",
          sessionParams: { sessionId: "poisoned-session" },
        },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        clearSession: true,
        summary: "Dropped a poisoned session.",
      };
    };

    await invokeAndSettle(agentId, issueId);

    expect(await readTaskSession(agentId)).toBeNull();
  });

  it("makes the checkpoint readable before the run finalizes, not only after", async () => {
    // The discriminator for "as soon as it is knowable": if the sink only
    // flushed at finalization, a read taken from inside the adapter's own
    // execution -- before it throws or returns -- would see nothing. The test
    // reads the row from within adapterBehavior itself, strictly before the
    // throw that ends the run.
    const { agentId, issueId } = await seedFixture();
    let taskSessionDuringRun: Awaited<ReturnType<typeof readTaskSession>> | undefined;
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "mid-flight-session",
          sessionParams: { sessionId: "mid-flight-session" },
        },
      });
      taskSessionDuringRun = await readTaskSession(agentId);
      throw new Error("harness was killed mid-run");
    };

    await invokeAndSettle(agentId, issueId);

    expect(taskSessionDuringRun?.sessionDisplayId).toBe("mid-flight-session");
    expect(taskSessionDuringRun?.taskKey).toBe(issueId);
  });

  it("hands the checkpointed session back as the resume argument on the next wake", async () => {
    // The acceptance test the spec actually asks for (spec.md: "the retry
    // SHALL pass the interrupted run's harness session id to the harness as a
    // resume argument"): a checkpoint that merely looks right in the row is
    // not the same claim as the NEXT dispatch honouring it. This drives a
    // second run for the same agent/issue and reads what the adapter itself
    // was handed.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "resume-me-session",
          sessionParams: { sessionId: "resume-me-session" },
        },
      });
      throw new Error("harness was killed mid-run");
    };
    await invokeAndSettle(agentId, issueId);

    let resumeRuntime: AdapterExecutionContext["runtime"] | undefined;
    adapterBehavior = async (input) => {
      resumeRuntime = input.runtime;
      return { exitCode: 0, signal: null, timedOut: false, summary: "Resumed cleanly." };
    };
    // A plain "issue_assigned" wake is a fresh assignment and always resets
    // the task session (shouldResetTaskSessionForWake) -- unrelated to this
    // sink and not the scenario the spec is about. "process_lost_retry" is
    // the actual acceptance scenario: the wake reason the process-loss retry
    // itself carries (enqueueProcessLossRetry sets it), so this is the real
    // resume path, not a synthetic stand-in for it.
    const finishedRun = await invokeAndSettle(agentId, issueId, "process_lost_retry");

    expect(finishedRun?.status).toBe("succeeded");
    expect(resumeRuntime?.sessionDisplayId ?? resumeRuntime?.sessionParams?.sessionId).toBe(
      "resume-me-session",
    );
  });

  it("ignores a checkpoint that carries neither session params nor a session id", async () => {
    // A malformed or empty checkpoint must not create a session row: a row with
    // no id would still count as "a session exists" on the next wake.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: { attempt: 1 },
      });
      throw new Error("harness was killed mid-run");
    };

    await invokeAndSettle(agentId, issueId);

    expect(await readTaskSession(agentId)).toBeNull();
  });

  // The finalization upsert is the second place a checkpoint can be clobbered,
  // and it is the one the live exposure runs through: a graceful shutdown
  // where the adapter RETURNS rather than throws, naming none of
  // sessionParams/sessionId/sessionDisplayId. That is the non-canonical
  // branch's shouldUsePrevious fallback, which reads the pre-dispatch snapshot
  // -- null on a first run -- and resolves to nothing, at which point
  // finalization CLEARS the row. The checkpoint now stands in as "previous"
  // there, exactly as it does on the adapter-threw path.
  it("keeps the checkpoint when the adapter returns interrupted with no session fields", async () => {
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "graceful-shutdown-session",
          sessionParams: { sessionId: "graceful-shutdown-session" },
        },
      });
      // A SIGTERM-interrupted adapter that RETURNS rather than throws, and
      // names none of sessionParams/sessionId/sessionDisplayId -- the shape
      // that reaches resolveNextSessionState's shouldUsePrevious fallback on
      // the non-canonical (every local-child) branch.
      return { exitCode: 130, signal: "SIGTERM", timedOut: false };
    };

    await invokeAndSettle(agentId, issueId);

    const taskSession = await readTaskSession(agentId);
    expect(taskSession?.sessionDisplayId).toBe("graceful-shutdown-session");
    expect(taskSession?.sessionParamsJson).toMatchObject({ sessionId: "graceful-shutdown-session" });
  });

  it("keeps the checkpoint when the adapter times out without naming a session", async () => {
    // The other result shape that reaches shouldUsePrevious: a timeout is the
    // run being killed by the server's own clock rather than by a signal, and
    // it names no session either. It resolves through the same fallback, so
    // it is pinned separately rather than assumed from the SIGTERM case.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "timed-out-session",
          sessionParams: { sessionId: "timed-out-session" },
        },
      });
      return { exitCode: null, signal: "SIGKILL", timedOut: true };
    };

    await invokeAndSettle(agentId, issueId);

    const taskSession = await readTaskSession(agentId);
    expect(taskSession?.sessionDisplayId).toBe("timed-out-session");
    expect(taskSession?.sessionParamsJson).toMatchObject({ sessionId: "timed-out-session" });
  });

  it("keeps the checkpoint when the adapter names its session fields explicitly as null", async () => {
    // Not the same case as omitting them. resolveNextSessionState reads
    // `sessionParams !== undefined` as "the adapter answered", so an explicit
    // null bypasses the shouldUsePrevious fallback entirely and resolves to
    // nothing on its own. This is a real shape, not a hypothetical: codex's
    // output-inactivity monitor kills the child and returns exactly
    // { sessionId: null, sessionParams: null, sessionDisplayId: null }
    // (codex-local/src/server/execute.ts). Naming nothing is not the same
    // signal as clearSession, so the checkpoint survives it.
    const { agentId, issueId } = await seedFixture();
    adapterBehavior = async (input) => {
      await input.onEvent?.({
        eventType: SESSION_CHECKPOINT_EVENT_TYPE,
        payload: {
          attempt: 1,
          sessionId: "inactivity-killed-session",
          sessionParams: { sessionId: "inactivity-killed-session" },
        },
      });
      return {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        errorMessage: "No output for too long",
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
      };
    };

    await invokeAndSettle(agentId, issueId);

    const taskSession = await readTaskSession(agentId);
    expect(taskSession?.sessionDisplayId).toBe("inactivity-killed-session");
    expect(taskSession?.sessionParamsJson).toMatchObject({ sessionId: "inactivity-killed-session" });
  });
});

// Mirrors G1's own wire-contract test (packages/adapter-utils/src/session-checkpoint.test.ts)
// from the host side. The sink deliberately duplicates the event-type literal
// rather than importing it (see session-checkpoint.ts's header comment), so
// this is the only test that imports BOTH halves in one place to prove they
// still agree -- it does not weaken the "no import in the sink itself" rule,
// which is about the production code, not the test.
describe("session checkpoint sink wire contract (mirrors G1)", () => {
  it("agrees with the adapter-side literal and the payload keys the sink reads", () => {
    expect(SESSION_CHECKPOINT_EVENT_TYPE).toBe("session.checkpoint");
    expect(SESSION_CHECKPOINT_EVENT_TYPE).toBe(ADAPTER_SIDE_SESSION_CHECKPOINT_EVENT_TYPE);

    // The payload keys the sink actually reads (proven by the malformed-
    // payload test above, which sends {attempt} alone and produces no row):
    // `sessionId` and `sessionParams`. `source` rides along for the recovery
    // classifier -- it distinguishes an id Paperclip supplied before the
    // harness confirmed it from one the harness named itself, which is what
    // separates outcome 1 from outcome 3 -- and the sink ignores it.
    const payload: SessionCheckpointPayload = {
      attempt: 1,
      sessionId: "contract-check-session",
      sessionParams: { sessionId: "contract-check-session" },
      source: "stream",
    };
    expect(Object.keys(payload).sort()).toEqual(["attempt", "sessionId", "sessionParams", "source"]);
  });
});
