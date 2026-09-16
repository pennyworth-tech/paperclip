import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueLabels,
  issueReadStates,
  issues,
  labels,
  projects,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres label enrichment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("configured labels and atomic enrichment", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-label-enrichment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(labels);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertLabel(companyId: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.insert(labels).values({ id, companyId, name, color: "#000000" });
    return id;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LabelProbe",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async () => null,
      },
    });
    const issueSvc = issueService(db);
    return { companyId, agentId, issueSvc, svc };
  }

  async function createRoutine(
    fixture: Awaited<ReturnType<typeof seedFixture>>,
    originKind: "manual" | "pipeline_automation",
  ) {
    const routine = await fixture.svc.create(
      fixture.companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "stamp probe routine",
        description: "Probe the fired issue's labels",
        assigneeAgentId: fixture.agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    if (originKind !== "manual") {
      await db
        .update(routines)
        .set({ originKind, originId: randomUUID() })
        .where(eq(routines.id, routine.id));
    }
    return routine;
  }

  async function labelNamesForIssue(issueId: string): Promise<string[]> {
    const issue = await issueService(db).getById(issueId);
    expect(issue).not.toBeNull();
    return (issue!.labels as Array<{ name: string }>).map((label) => label.name).sort();
  }

  it("inherits only the configured company labels on a pipeline stage issue", async () => {
    const fixture = await seedFixture();
    const first = await insertLabel(fixture.companyId, "review");
    const second = await insertLabel(fixture.companyId, "release");
    const foreign = await seedFixture();
    const foreignId = await insertLabel(foreign.companyId, "other");
    const routine = await createRoutine(fixture, "pipeline_automation");
    const run = await fixture.svc.runPipelineStageEntryRoutine(routine.id, {
      source: "api", issueLabelIds: [first, second, first, foreignId, randomUUID(), "invalid-id"],
    });
    expect(await labelNamesForIssue(run.linkedIssueId!)).toEqual(["release", "review"]);
  });

  it("leaves an ordinary routine's labels unconfigured", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "review");
    const routine = await createRoutine(fixture, "manual");
    const run = await fixture.svc.runRoutine(routine.id, { source: "manual" });
    expect(await labelNamesForIssue(run.linkedIssueId!)).toEqual([]);
  });

  async function seedLabeledIssue() {
    const fixture = await seedFixture();
    const initial = await insertLabel(fixture.companyId, "initial");
    const first = await insertLabel(fixture.companyId, "first");
    const second = await insertLabel(fixture.companyId, "second");
    const created = await fixture.issueSvc.create(fixture.companyId, {
      title: "Concurrent enrichment", status: "todo", assigneeAgentId: fixture.agentId,
      labelIds: [initial],
    });
    return { ...fixture, created, initial, first, second };
  }

  it("preserves concurrent additions and makes repeated additions idempotent", async () => {
    const f = await seedLabeledIssue();
    await Promise.all([
      f.issueSvc.update(f.created.id, { addLabelIds: [f.first], companyGuard: f.companyId }),
      f.issueSvc.update(f.created.id, { addLabelIds: [f.second, f.second], companyGuard: f.companyId }),
    ]);
    expect(await labelNamesForIssue(f.created.id)).toEqual(["first", "initial", "second"]);
    await f.issueSvc.update(f.created.id, { addLabelIds: [f.first], companyGuard: f.companyId });
    expect(await labelNamesForIssue(f.created.id)).toEqual(["first", "initial", "second"]);
  });

  it("refuses cross-company labels without partially adding a valid label", async () => {
    const f = await seedLabeledIssue();
    const foreign = await seedFixture();
    const foreignId = await insertLabel(foreign.companyId, "foreign");
    await expect(f.issueSvc.update(f.created.id, { addLabelIds: [f.first, foreignId] }))
      .rejects.toThrow("invalid for this company");
    expect(await labelNamesForIssue(f.created.id)).toEqual(["initial"]);
  });

  it("requires an explicit choice between replacing and adding labels", async () => {
    const f = await seedLabeledIssue();
    await expect(f.issueSvc.update(f.created.id, { labelIds: [], addLabelIds: [f.first] }))
      .rejects.toThrow("cannot be combined");
    expect(await labelNamesForIssue(f.created.id)).toEqual(["initial"]);
  });

  it("keeps a foreign company's issue outside the guarded update", async () => {
    const f = await seedLabeledIssue();
    const changed = await f.issueSvc.update(f.created.id, { addLabelIds: [f.first], companyGuard: randomUUID() });
    expect(changed).toBeNull();
    expect(await labelNamesForIssue(f.created.id)).toEqual(["initial"]);
  });
});
