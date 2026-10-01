import express from "express";
import { createHash } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getOperatorDrain: vi.fn(),
  setOperatorDrain: vi.fn(),
  acquireReleaseDrain: vi.fn(),
  observeOperatorDrain: vi.fn(),
  clearReleaseDrain: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  getOperatorDrainSnapshot: vi.fn(),
  verifyReleaseDrain: vi.fn(),
  drainRunningRunsForShutdown: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: any) {
  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const adminActor = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  isInstanceAdmin: true,
};

const nonAdminBoardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

describe("instance operator drain routes", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/instance-settings.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getOperatorDrain.mockReset();
    mockInstanceSettingsService.setOperatorDrain.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockHeartbeatService.getOperatorDrainSnapshot.mockReset();
    mockHeartbeatService.drainRunningRunsForShutdown.mockReset();
    mockLogActivity.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockInstanceSettingsService.getOperatorDrain.mockResolvedValue({
      active: false,
      startedAt: null,
    });
    mockHeartbeatService.getOperatorDrainSnapshot.mockResolvedValue({
      runningCount: 0,
      queuedCount: 0,
    });
  });

  it("reports the drain state with live run counts to board readers", async () => {
    mockInstanceSettingsService.getOperatorDrain.mockResolvedValue({
      active: true,
      startedAt: "2026-08-28T17:00:00.000Z",
    });
    mockHeartbeatService.getOperatorDrainSnapshot.mockResolvedValue({
      runningCount: 3,
      queuedCount: 5,
    });
    const app = await createApp(nonAdminBoardActor);

    const res = await request(app).get("/api/instance/drain").expect(200);

    expect(res.body).toEqual({
      draining: true,
      startedAt: "2026-08-28T17:00:00.000Z",
      runningCount: 3,
      queuedCount: 5,
    });
  });

  it("sets the drain flag for instance admins and logs the activity", async () => {
    mockInstanceSettingsService.setOperatorDrain.mockResolvedValue({
      active: true,
      startedAt: "2026-08-28T17:00:00.000Z",
    });
    mockInstanceSettingsService.getOperatorDrain.mockResolvedValue({
      active: true,
      startedAt: "2026-08-28T17:00:00.000Z",
    });
    mockHeartbeatService.getOperatorDrainSnapshot.mockResolvedValue({
      runningCount: 2,
      queuedCount: 4,
    });
    const app = await createApp(adminActor);

    const res = await request(app).post("/api/instance/drain").expect(200);

    expect(mockInstanceSettingsService.setOperatorDrain).toHaveBeenCalledWith(true);
    expect(res.body).toMatchObject({ draining: true, runningCount: 2, queuedCount: 4 });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1].action).toBe("instance.drain.set");
  });

  it("clears the drain flag for instance admins", async () => {
    mockInstanceSettingsService.setOperatorDrain.mockResolvedValue({
      active: false,
      startedAt: null,
    });
    const app = await createApp(adminActor);

    const res = await request(app).delete("/api/instance/drain").expect(200);

    expect(mockInstanceSettingsService.setOperatorDrain).toHaveBeenCalledWith(false);
    expect(res.body).toMatchObject({ draining: false, startedAt: null });
    expect(mockLogActivity.mock.calls[0][1].action).toBe("instance.drain.cleared");
  });

  it("interrupts drain stragglers through the graceful-shutdown path", async () => {
    mockHeartbeatService.drainRunningRunsForShutdown.mockResolvedValue({
      interrupted: 2,
      interruptedRunIds: ["run-1", "run-2"],
      retryRunIds: ["retry-1", "retry-2"],
    });
    const app = await createApp(adminActor);

    const res = await request(app).post("/api/instance/drain/interrupt").expect(200);

    expect(mockHeartbeatService.drainRunningRunsForShutdown).toHaveBeenCalledWith("SIGTERM");
    expect(res.body).toMatchObject({ interrupted: 2, retryRunIds: ["retry-1", "retry-2"] });
    expect(mockLogActivity.mock.calls[0][1].action).toBe("instance.drain.interrupted");
  });

  it("rejects drain mutations from non-admin board users", async () => {
    const app = await createApp(nonAdminBoardActor);

    await request(app).post("/api/instance/drain").expect(403);
    await request(app).delete("/api/instance/drain").expect(403);
    await request(app).post("/api/instance/drain/interrupt").expect(403);

    expect(mockInstanceSettingsService.setOperatorDrain).not.toHaveBeenCalled();
    expect(mockHeartbeatService.drainRunningRunsForShutdown).not.toHaveBeenCalled();
  });
});


describe("external release drain authorization", () => {
  const token = "fixture-release-credential";
  const input = { ownerId: "release-service", generation: 12 };
  beforeEach(() => {
    vi.stubEnv("BACKLIT_RELEASE_DRAIN_OWNER_ID", input.ownerId);
    vi.stubEnv("BACKLIT_RELEASE_DRAIN_TOKEN_SHA256", createHash("sha256").update(token).digest("hex"));
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockInstanceSettingsService.acquireReleaseDrain.mockResolvedValue({ ...input, active: true, generation: 13 });
  });

  it("denies board and agent authority for every release verb", async () => {
    for (const actor of [adminActor, nonAdminBoardActor, { type: "agent", agentId: "agent-1", companyId: "company-1" }]) {
      const app = await createApp(actor);
      for (const verb of ["acquire", "verify", "clear", "interrupt"]) {
        await request(app).post(`/api/instance/drain/${verb}`).send(input).expect(401);
      }
      await request(app).get("/api/instance/drain/release").expect(401);
    }
    expect(mockInstanceSettingsService.acquireReleaseDrain).not.toHaveBeenCalled();
    expect(mockInstanceSettingsService.clearReleaseDrain).not.toHaveBeenCalled();
  });

  it("accepts only the configured external identity and binds the owner", async () => {
    const app = await createApp({ type: "none", source: "none" });
    await request(app).post("/api/instance/drain/acquire").set("Authorization", "Release wrong").send(input).expect(401);
    await request(app).post("/api/instance/drain/acquire").set("Authorization", `Release ${token}`).send({ ...input, ownerId: "other" }).expect(403);
    const response = await request(app).post("/api/instance/drain/acquire").set("Authorization", `Release ${token}`).send(input).expect(200);
    expect(response.body.generation).toBe(13);
    expect(mockInstanceSettingsService.acquireReleaseDrain).toHaveBeenCalledWith(input);
  });

  it("does not clear when the real host receipt is not quiescent", async () => {
    const app = await createApp({ type: "none", source: "none" });
    mockHeartbeatService.verifyReleaseDrain.mockResolvedValue({ quiescent: false, localProcessRunIds: ["hidden-run"] });
    await request(app).post("/api/instance/drain/clear").set("Authorization", `Release ${token}`).send(input).expect(409);
    expect(mockInstanceSettingsService.clearReleaseDrain).not.toHaveBeenCalled();
  });

  it("rejects unbounded or malformed release interruption requests", async () => {
    const app = await createApp({ type: "none", source: "none" });
    for (const patch of [{}, { runIds: [] }, { runIds: ["not-a-run"] }, { runIds: ["00000000-0000-4000-8000-000000000000"], graceMs: 30001 }]) {
      await request(app).post("/api/instance/drain/interrupt").set("Authorization", `Release ${token}`).send({ ...input, ...patch }).expect(400);
    }
    expect(mockHeartbeatService.drainRunningRunsForShutdown).not.toHaveBeenCalled();
  });
});
