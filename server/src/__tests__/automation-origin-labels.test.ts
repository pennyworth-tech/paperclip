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
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres automation-origin label tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Automation-origin label stamping: issues the
 * platform's own automation creates are stamped with their taxonomy labels at
 * creation — `source:pipeline` / `source:routine` on every routine-fired issue
 * (derived from the firing routine's origin, plus stage-config-carried label
 * ids), `source:recovery` on every recovery-classifier create, plus
 * `needs:human` when no agent owns the outcome. Names resolve against the
 * company's labels; absent names stamp nothing and fail nothing.
 */
describeEmbeddedPostgres("automation-origin label stamping", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-automation-origin-labels-");
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
      name: "AutomationStampProbe",
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

  it("stamps source:routine on a routine-fired issue when the routine is not a pipeline automation", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "source:routine");
    await insertLabel(fixture.companyId, "source:pipeline");
    const routine = await createRoutine(fixture, "manual");
    const run = await fixture.svc.runRoutine(routine.id, { source: "manual" });
    expect(run.linkedIssueId).toBeTruthy();
    expect(await labelNamesForIssue(run.linkedIssueId!)).toEqual(["source:routine"]);
  });

  it("stamps source:pipeline plus the carried stage-config labels on a pipeline stage automation fire", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "source:routine");
    await insertLabel(fixture.companyId, "source:pipeline");
    const kindReviewId = await insertLabel(fixture.companyId, "kind:review");
    const mergeQueueId = await insertLabel(fixture.companyId, "merge-queue");
    const routine = await createRoutine(fixture, "pipeline_automation");
    const run = await fixture.svc.runPipelineStageEntryRoutine(routine.id, {
      source: "api",
      issueLabelIds: [kindReviewId, mergeQueueId],
    });
    expect(run.linkedIssueId).toBeTruthy();
    expect(await labelNamesForIssue(run.linkedIssueId!)).toEqual([
      "kind:review",
      "merge-queue",
      "source:pipeline",
    ]);
  });

  it("drops carried label ids that no longer exist instead of failing the dispatch", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "source:pipeline");
    const staleId = randomUUID();
    const routine = await createRoutine(fixture, "pipeline_automation");
    const run = await fixture.svc.runPipelineStageEntryRoutine(routine.id, {
      source: "api",
      issueLabelIds: [staleId],
    });
    expect(run.linkedIssueId).toBeTruthy();
    expect(await labelNamesForIssue(run.linkedIssueId!)).toEqual(["source:pipeline"]);
  });

  it("creates the fired issue with zero labels and no error when the company has no taxonomy labels", async () => {
    const fixture = await seedFixture();
    const routine = await createRoutine(fixture, "manual");
    const run = await fixture.svc.runRoutine(routine.id, { source: "manual" });
    expect(run.linkedIssueId).toBeTruthy();
    expect(await labelNamesForIssue(run.linkedIssueId!)).toEqual([]);
  });

  it("stamps source:recovery on a recovery-origin create assigned to an agent, without needs:human", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "source:recovery");
    await insertLabel(fixture.companyId, "needs:human");
    const issue = await fixture.issueSvc.create(fixture.companyId, {
      title: "Recover the monitor",
      description: null,
      status: "todo",
      assigneeAgentId: fixture.agentId,
      originKind: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
    });
    expect(await labelNamesForIssue(issue.id)).toEqual(["source:recovery"]);
  });

  it("adds needs:human when a recovery-origin create has no agent assignee — the human gate", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "source:recovery");
    await insertLabel(fixture.companyId, "needs:human");
    const issue = await fixture.issueSvc.create(fixture.companyId, {
      title: "Unblock the stalled tree",
      description: null,
      status: "todo",
      originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
    });
    expect(await labelNamesForIssue(issue.id)).toEqual(["needs:human", "source:recovery"]);
  });

  it("derives no stamps for a manual-origin create even without an agent assignee", async () => {
    const fixture = await seedFixture();
    await insertLabel(fixture.companyId, "source:recovery");
    await insertLabel(fixture.companyId, "needs:human");
    const issue = await fixture.issueSvc.create(fixture.companyId, {
      title: "A plain unassigned issue",
      description: null,
      status: "todo",
      originKind: "manual",
    });
    expect(await labelNamesForIssue(issue.id)).toEqual([]);
  });

  it("keeps recovery stamps inert when the taxonomy labels do not exist, and merges caller-carried labelIds", async () => {
    const fixture = await seedFixture();
    const carriedId = await insertLabel(fixture.companyId, "kind:operator-action");
    const issue = await fixture.issueSvc.create(fixture.companyId, {
      title: "Recovery with a carried label",
      description: null,
      status: "todo",
      originKind: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
      labelIds: [carriedId],
    });
    expect(await labelNamesForIssue(issue.id)).toEqual(["kind:operator-action"]);
  });
});
