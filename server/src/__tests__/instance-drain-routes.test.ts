import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getOperatorDrain: vi.fn(),
  setOperatorDrain: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  getOperatorDrainSnapshot: vi.fn(),
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
