import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, instanceSettings, companies, agents, heartbeatRuns, agentWakeupRequests, environmentLeases } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("generation-owned release drain", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const runtimeEnv = { PAPERCLIP_RELEASE_DRAIN_DOCKER: "none" };
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-release-drain-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(process.env.PAPERCLIP_SCRATCH_DIR ?? os.tmpdir(), "release-drain-home-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
  }, 30_000);
  beforeEach(async () => { await db.delete(instanceSettings); });
  afterAll(async () => {
    await tempDb?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function runHostProcess(mode: "register" | "acquire-verify" | "verify", generation = 0) {
    const script = `
      import { createDb } from "@paperclipai/db";
      import { instanceSettingsService } from "./src/services/instance-settings.ts";
      import { heartbeatService } from "./src/services/heartbeat.ts";
      import { releaseDrainHostId } from "./src/services/release-drain-runtime.ts";
      const db = createDb(process.env.RELEASE_DRAIN_TEST_DB);
      const settings = instanceSettingsService(db);
      await settings.observeOperatorDrain(releaseDrainHostId);
      if (process.env.RELEASE_DRAIN_TEST_MODE === "register") {
        console.log(JSON.stringify({ hostId: releaseDrainHostId }));
      } else {
        const input = { ownerId: "release-process-restart", generation: Number(process.env.RELEASE_DRAIN_TEST_GENERATION) };
        if (process.env.RELEASE_DRAIN_TEST_MODE === "acquire-verify") {
          input.generation = (await settings.acquireReleaseDrain(input)).generation;
        }
        const heartbeat = heartbeatService(db, { runtimeEnv: { PAPERCLIP_RELEASE_DRAIN_DOCKER: "none" } });
        await heartbeat.reapOrphanedRuns();
        await heartbeat.resumeQueuedRuns();
        console.log(JSON.stringify(await heartbeat.verifyReleaseDrain(input)));
      }
      process.exit(0);
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: 30_000,
      env: { ...process.env, RELEASE_DRAIN_TEST_DB: tempDb.connectionString, RELEASE_DRAIN_TEST_MODE: mode, RELEASE_DRAIN_TEST_GENERATION: String(generation) },
    });
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  }

  it("rejects a stale release clear without clearing a concurrent manual drain", async () => {
    const settings = instanceSettingsService(db);
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-one", generation: 0 });
    await settings.setOperatorDrain(true);
    const before = await settings.getOperatorDrain();
    await expect(settings.clearReleaseDrain({ ownerId: "release-one", generation: drain.generation }))
      .rejects.toMatchObject({ status: 409 });
    expect(await settings.getOperatorDrain()).toEqual(before);
    expect(before.active).toBe(true);
    expect(before.ownerId).toBeNull();
    await settings.setOperatorDrain(false);
  });

  it("refuses to acquire a preexisting manual drain and preserves settings", async () => {
    const settings = instanceSettingsService(db);
    await settings.setOperatorDrain(true);
    const before = await settings.get();
    const drain = await settings.getOperatorDrain();
    await expect(settings.acquireReleaseDrain({ ownerId: "release-two", generation: drain.generation }))
      .rejects.toMatchObject({ status: 409 });
    expect(await settings.get()).toEqual(before);
    await settings.setOperatorDrain(false);
  });

  it("serializes concurrent acquisitions and rejects the losing generation", async () => {
    const settings = instanceSettingsService(db);
    const state = await settings.getOperatorDrain();
    const results = await Promise.allSettled([
      settings.acquireReleaseDrain({ ownerId: "release-a", generation: state.generation }),
      settings.acquireReleaseDrain({ ownerId: "release-b", generation: state.generation }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await settings.getOperatorDrain();
    await Promise.all([
      settings.updateExperimental({ enableApps: true }),
      settings.updateExperimental({ enableEnvironments: true }),
    ]);
    expect(await settings.getOperatorDrain()).toEqual(current);
    await expect(settings.clearReleaseDrain({ ownerId: "wrong-owner", generation: current.generation }))
      .rejects.toMatchObject({ status: 409 });
    await settings.setOperatorDrain(true);
    await settings.setOperatorDrain(false);
  });

  it("reports a live local process even with no running ledger rows", async () => {
    const settings = instanceSettingsService(db);
    const state = await settings.getOperatorDrain();
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-hidden", generation: state.generation });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    const runId = randomUUID();
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: child.pid! });
    try {
      const receipt = await heartbeatService(db, { runtimeEnv }).verifyReleaseDrain({ ownerId: "release-hidden", generation: drain.generation });
      expect(receipt.runningCount).toBe(0);
      expect(receipt.quiescent).toBe(false);
      expect(receipt.localProcessRunIds).toContain(runId);
      await expect(settings.clearReleaseDrain({ ownerId: "release-hidden", generation: drain.generation }))
        .rejects.toMatchObject({ status: 409 });
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
      runningProcesses.delete(runId);
      await settings.setOperatorDrain(true);
      await settings.setOperatorDrain(false);
    }
  });

  it("fails closed for unknown provider cleanup and released reusable leases", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease receipt", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    const settings = instanceSettingsService(db);
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-leases", generation: 0 });
    const input = { ownerId: "release-leases", generation: drain.generation };
    const heartbeat = heartbeatService(db, { runtimeEnv });
    const leases = await db.insert(environmentLeases).values([
      { companyId, provider: "sandbox", providerLeaseId: "unknown", status: "failed" },
      { companyId, provider: "sandbox", providerLeaseId: "reusable", status: "released", leasePolicy: "reuse_by_environment", cleanupStatus: "success" },
    ]).returning();
    try {
      const receipt = await heartbeat.verifyReleaseDrain(input);
      expect(receipt.quiescent).toBe(false);
      expect(receipt.leaseIds.sort()).toEqual(leases.map((lease) => lease.id).sort());
      await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success" }).where(eq(environmentLeases.companyId, companyId));
      expect((await heartbeat.verifyReleaseDrain(input)).quiescent).toBe(true);
    } finally {
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  });

  it("retains an unacknowledged old host across restart", async () => {
    const settings = instanceSettingsService(db);
    await settings.observeOperatorDrain("previous-boot");
    const state = await settings.getOperatorDrain();
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-restart", generation: state.generation });
    const restarted = instanceSettingsService(db);
    await restarted.observeOperatorDrain("new-boot");
    await restarted.acknowledgeReleaseDrain({ ownerId: "release-restart", generation: drain.generation }, "new-boot");
    await expect(restarted.clearReleaseDrain({ ownerId: "release-restart", generation: drain.generation }))
      .rejects.toMatchObject({ status: 409 });
    expect((await restarted.getOperatorDrain()).pendingHostIds).toContain("previous-boot");
    await settings.setOperatorDrain(true);
    await settings.setOperatorDrain(false);
  });

  it("acknowledges existing service instances immediately and verifies a fresh boot before clear", async () => {
    const settings = instanceSettingsService(db);
    const oldService = heartbeatService(db, { runtimeEnv });
    expect((await oldService.resolveSchedulingSuppression()).suppressed).toBe(false);
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-ok", generation: 0 });
    const input = { ownerId: "release-ok", generation: drain.generation };
    expect(await oldService.resolveSchedulingSuppression()).toEqual({ suppressed: true, reason: "operator_drain" });
    const newService = heartbeatService(db, { runtimeEnv });
    expect(await newService.prepareHotRestartShutdown("SIGTERM")).toMatchObject({ mode: "release_drain", skipDrain: true });
    expect(await newService.reconcileHotRestartAdoption()).toMatchObject({ mode: "release_drain" });
    expect(await newService.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect(await newService.sweepPendingCleanupLeases()).toEqual({ swept: 0, destroyed: 0, capped: 0 });
    expect(await newService.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
    expect(await newService.sweepStaleIssueLocks()).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    await newService.resumeQueuedRuns();
    expect(await newService.verifyReleaseDrain(input)).toMatchObject({ quiescent: true, suppressionAcknowledged: true });
    expect((await settings.clearReleaseDrain(input)).active).toBe(false);
    const before = await settings.get();
    await expect(settings.clearReleaseDrain(input)).rejects.toMatchObject({ status: 409 });
    expect(await settings.get()).toEqual(before);
    expect((await oldService.resolveSchedulingSuppression()).suppressed).toBe(false);
  });

  it("keeps operational state when an unrelated flag is malformed and strips client control writes", async () => {
    const settings = instanceSettingsService(db);
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-patch", generation: 0 });
    await settings.updateExperimental({ operatorDrainControl: { ownerId: "intruder", generation: 200, hosts: {} }, operatorDrainActive: false } as never);
    expect((await settings.getOperatorDrain()).generation).toBe(drain.generation);
    const [row] = await db.select().from(instanceSettings);
    await db.update(instanceSettings).set({ experimental: { ...row.experimental, enableApps: "invalid" } }).where(eq(instanceSettings.id, row.id));
    expect(await settings.getOperatorDrain()).toMatchObject({ active: true, ownerId: "release-patch", generation: drain.generation });
  });

  it("gives a simultaneous manual drain precedence over release acquisition", async () => {
    const settings = instanceSettingsService(db);
    await settings.get();
    await Promise.allSettled([
      settings.acquireReleaseDrain({ ownerId: "release-race", generation: 0 }),
      settings.setOperatorDrain(true),
    ]);
    expect(await settings.getOperatorDrain()).toMatchObject({ active: true, ownerId: null });
  });

  it("cannot use a replacement process to acknowledge an unverified crashed boot", async () => {
    const previous = await runHostProcess("register");
    const settings = instanceSettingsService(db);
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-process-restart", generation: 0 });
    const replacement = await runHostProcess("verify", drain.generation);
    expect(replacement.hostId).not.toBe(previous.hostId);
    expect(replacement.locallyQuiescent).toBe(true);
    expect(replacement.quiescent).toBe(false);
    expect(replacement.pendingHostIds).toContain(previous.hostId);
  }, 60_000);

  it("accepts a replacement process after a verified planned restart", async () => {
    const previous = await runHostProcess("acquire-verify");
    expect(previous.quiescent).toBe(true);
    const replacement = await runHostProcess("verify", previous.generation);
    expect(replacement.hostId).not.toBe(previous.hostId);
    expect(replacement.quiescent).toBe(true);
    expect(replacement.pendingHostIds).toEqual([]);
  }, 60_000);

  it("interrupts only owned runs and queues one retry with its checkpoint while preserving a pause", async () => {
    const settings = instanceSettingsService(db);
    const drain = await settings.acquireReleaseDrain({ ownerId: "release-interrupt", generation: 0 });
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Release", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Paused agent", role: "engineer", status: "paused", adapterType: "process" });
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId, source: "assignment", status: "claimed", runId });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    const exit = once(child, "exit");
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", wakeupRequestId: wakeupId, sessionIdAfter: "saved-session", contextSnapshot: { checkpoint: "saved-context" }, resultJson: { checkpoint: "saved-result" }, processPid: child.pid, processGroupId: child.pid });
    const heartbeat = heartbeatService(db, { runtimeEnv });
    const input = { ownerId: "release-interrupt", generation: drain.generation, graceMs: 50 };
    try {
      await expect(heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [runId], input)).rejects.toMatchObject({ status: 409 });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe("running");
      runningProcesses.set(runId, { child, graceSec: 1, processGroupId: child.pid! });
      const results = await Promise.all([
        heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [runId], input),
        heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [runId], input),
      ]);
      await exit;
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ status: "queued", sessionIdBefore: "saved-session", contextSnapshot: { checkpoint: "saved-context" } });
      expect(results[0].retryRunIds).toEqual([retries[0].id]);
      expect(results[1].retryRunIds).toEqual([retries[0].id]);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(source).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted", resultJson: { checkpoint: "saved-result" } });
      expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].status).toBe("paused");
    } finally {
      child.kill("SIGKILL");
      await exit;
      runningProcesses.delete(runId);
    }
  });

});
