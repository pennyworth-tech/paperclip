import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Executed.",
  provider: "test",
  model: "test-model",
})));

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

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat operator drain", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operator-drain-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  async function seedQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Drain Co",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DrainAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    }).returning().then((rows) => {
      // link below
      return rows[0];
    }).then(async (wakeup) => {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeup.id,
        contextSnapshot: { issueId },
      });
      await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeup.id));
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Drain holds queued runs",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `DR-${companyId.replace(/-/g, "").slice(0, 4)}`,
    });
    return { companyId, agentId, runId, issueId };
  }

  it("suppresses scheduling with reason operator_drain while the flag is set", async () => {
    const settings = instanceSettingsService(db);
    await settings.setOperatorDrain(true);
    try {
      // Fresh service instances read the flag on first check (the 3s TTL cache
      // starts cold per service instance, matching how a booting revision
      // would observe it).
      const heartbeat = heartbeatService(db);
      expect(await heartbeat.resolveSchedulingSuppression()).toEqual({
        suppressed: true,
        reason: "operator_drain",
      });
    } finally {
      await settings.setOperatorDrain(false);
    }
  });

  it("holds queued runs while draining and resumes after the drain clears", async () => {
    const { runId } = await seedQueuedRun();
    const settings = instanceSettingsService(db);
    await settings.setOperatorDrain(true);
    try {
      const drainingHeartbeat = heartbeatService(db);
      await drainingHeartbeat.resumeQueuedRuns();
      const held = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(held).toEqual([{ status: "queued" }]);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    } finally {
      await settings.setOperatorDrain(false);
    }

    // A fresh service instance (the post-promote revision) sees the cleared
    // flag and dispatches again.
    const resumedHeartbeat = heartbeatService(db);
    expect(await resumedHeartbeat.resolveSchedulingSuppression()).toEqual({
      suppressed: false,
      reason: null,
    });
    await resumedHeartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => {
      const dispatched = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(["running", "succeeded"]).toContain(dispatched[0]?.status);
    }, 10_000);
  }, 30_000);

  it("reports instance-wide live run counts for the drain surface", async () => {
    const { runId } = await seedQueuedRun();
    const heartbeat = heartbeatService(db);
    const snapshot = await heartbeat.getOperatorDrainSnapshot();
    expect(snapshot.queuedCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.runningCount).toBeGreaterThanOrEqual(0);
    expect(snapshot).toEqual({
      runningCount: snapshot.runningCount,
      queuedCount: snapshot.queuedCount,
    });
    // sanity: the seeded run is visible
    expect(snapshot.queuedCount).toBeGreaterThanOrEqual(1);
    void runId;
  });
});
