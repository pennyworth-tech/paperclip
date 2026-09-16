import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  computeActiveExecutionMs,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  productivityReviewService,
} from "../services/productivity-review.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review active-execution/owner-burst tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

describe("computeActiveExecutionMs", () => {
  const T = new Date("2026-04-28T12:00:00.000Z").getTime();
  const at = (offsetMs: number) => new Date(T + offsetMs);
  const hours = (n: number) => n * HOUR_MS;

  it("R3: never-started runs contribute nothing", () => {
    expect(
      computeActiveExecutionMs(
        [
          { status: "queued", startedAt: null, finishedAt: null, updatedAt: at(-hours(11)) },
          { status: "cancelled", startedAt: null, finishedAt: null, updatedAt: at(-hours(10)) },
        ],
        at(-hours(11)),
        at(0),
      ),
    ).toBe(0);
  });

  it("R4: a running run accrues to now", () => {
    expect(
      computeActiveExecutionMs(
        [{ status: "running", startedAt: at(-hours(7)), finishedAt: null, updatedAt: at(-MINUTE_MS) }],
        at(-hours(7)),
        at(0),
      ),
    ).toBe(hours(7));
  });

  it("R5: scheduled_retry and queued runs end at finishedAt ?? updatedAt, never now", () => {
    expect(
      computeActiveExecutionMs(
        [{ status: "scheduled_retry", startedAt: at(-hours(9)), finishedAt: null, updatedAt: at(-hours(8)) }],
        at(-hours(10)),
        at(0),
      ),
    ).toBe(hours(1));
    expect(
      computeActiveExecutionMs(
        [{ status: "queued", startedAt: at(-hours(9)), finishedAt: null, updatedAt: at(-hours(8)) }],
        at(-hours(10)),
        at(0),
      ),
    ).toBe(hours(1));
  });

  it("R6: overlapping intervals from concurrent runs count once", () => {
    const run = {
      status: "succeeded",
      startedAt: at(-hours(5)),
      finishedAt: at(-hours(1)),
      updatedAt: at(-hours(1)),
    };
    expect(computeActiveExecutionMs([run, { ...run }], at(-hours(6)), at(0))).toBe(hours(4));
    expect(
      computeActiveExecutionMs(
        [
          run,
          { status: "succeeded", startedAt: at(-hours(4)), finishedAt: at(0), updatedAt: at(0) },
        ],
        at(-hours(6)),
        at(0),
      ),
    ).toBe(hours(5));
  });

  it("R7: intervals clip to [episodeStart, now)", () => {
    expect(
      computeActiveExecutionMs(
        [{ status: "succeeded", startedAt: at(-hours(5)), finishedAt: at(-hours(1)), updatedAt: at(-hours(1)) }],
        at(-hours(3)),
        at(0),
      ),
    ).toBe(hours(2));
    expect(
      computeActiveExecutionMs(
        [{ status: "succeeded", startedAt: at(-hours(9)), finishedAt: at(-hours(8)), updatedAt: at(-hours(8)) }],
        at(-hours(3)),
        at(0),
      ),
    ).toBe(0);
  });

  it("terminal run without finishedAt ends at updatedAt", () => {
    expect(
      computeActiveExecutionMs(
        [{ status: "failed", startedAt: at(-hours(7)), finishedAt: null, updatedAt: at(-hours(6)) }],
        at(-hours(8)),
        at(0),
      ),
    ).toBe(hours(1));
  });
});

describe("productivity review experimental settings schema", () => {
  it("R11: per-owner cap rejects 0 and negatives, accepts 1..50, defaults to 1 with both gates off", () => {
    expect(
      instanceExperimentalSettingsSchema.safeParse({ productivityReviewMaxCreationsPerOwnerPerSweep: 0 })
        .success,
    ).toBe(false);
    expect(
      instanceExperimentalSettingsSchema.safeParse({ productivityReviewMaxCreationsPerOwnerPerSweep: -1 })
        .success,
    ).toBe(false);
    expect(
      instanceExperimentalSettingsSchema.safeParse({ productivityReviewMaxCreationsPerOwnerPerSweep: 51 })
        .success,
    ).toBe(false);
    expect(
      instanceExperimentalSettingsSchema.parse({}).productivityReviewMaxCreationsPerOwnerPerSweep,
    ).toBe(1);
    expect(
      instanceExperimentalSettingsSchema.parse({ productivityReviewMaxCreationsPerOwnerPerSweep: 50 })
        .productivityReviewMaxCreationsPerOwnerPerSweep,
    ).toBe(50);
    const defaults = instanceExperimentalSettingsSchema.parse({});
    expect(defaults.enableProductivityReviewActiveExecutionDuration).toBe(false);
    expect(defaults.enableProductivityReviewOwnerBurstCap).toBe(false);
  });
});

describeEmbeddedPostgres("productivity review active execution and owner burst cap", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-gates-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await instanceSettingsService(db).updateExperimental({
      enableProductivityReviewActiveExecutionDuration: false,
      enableProductivityReviewOwnerBurstCap: false,
      productivityReviewMaxCreationsPerOwnerPerSweep: 1,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  interface SeedIssueSpec {
    key: string;
    startedAt: Date | null;
    executionLockedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }

  async function seedOrgWithIssues(specs: SeedIssueSpec[]) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const issuePrefix = `BG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const rows = specs.map((spec, index) => ({
      spec,
      coderId: randomUUID(),
      issueId: randomUUID(),
      issueNumber: index + 1,
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Burst Gate Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      ...rows.map((row) => ({
        id: row.coderId,
        companyId,
        name: `Coder ${row.spec.key}`,
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    ]);
    await db.insert(issues).values(
      rows.map((row) => ({
        id: row.issueId,
        companyId,
        title: `Issue ${row.spec.key}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: row.coderId,
        parentId: null,
        originKind: "manual",
        issueNumber: row.issueNumber,
        identifier: `${issuePrefix}-${row.issueNumber}`,
        startedAt: row.spec.startedAt,
        executionLockedAt: row.spec.executionLockedAt ?? null,
        createdAt: row.spec.createdAt,
        updatedAt: row.spec.updatedAt,
      })),
    );

    return {
      companyId,
      managerId,
      issuePrefix,
      issues: Object.fromEntries(
        rows.map((row) => [row.spec.key, { issueId: row.issueId, coderId: row.coderId }]),
      ) as Record<string, { issueId: string; coderId: string }>,
    };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    startedAt: Date | null;
    finishedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      livenessState: "advanced",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
  }

  // A measured production shape, scaled down: an 11h wall-clock episode whose
  // unioned execution is 96m (8 succeeded 12m runs with queue gaps), all runs
  // older than the 6h churn windows.
  async function seedNettedFixture(now: Date) {
    const episodeStart = new Date(now.getTime() - 11 * HOUR_MS);
    const seeded = await seedOrgWithIssues([
      {
        key: "source",
        startedAt: episodeStart,
        createdAt: episodeStart,
        updatedAt: episodeStart,
      },
    ]);
    const source = seeded.issues.source;
    for (let index = 0; index < 8; index += 1) {
      const startedAt = new Date(episodeStart.getTime() + (10 + index * 22) * MINUTE_MS);
      await insertRun({
        companyId: seeded.companyId,
        agentId: source.coderId,
        issueId: source.issueId,
        status: "succeeded",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 12 * MINUTE_MS),
        createdAt: startedAt,
        updatedAt: new Date(startedAt.getTime() + 12 * MINUTE_MS),
      });
    }
    return seeded;
  }

  async function listReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function refreshCommentCount(reviewIssueId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, reviewIssueId),
          sql`${issueComments.body} like 'Productivity review evidence refreshed.%'`,
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  it("R1: both gates off fires on wall-clock and the result deep-equals the pinned-base shape (no ownerBurstDeferred key)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedNettedFixture(now);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    const reviews = await listReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(result).toStrictEqual({
      scanned: 1,
      created: 1,
      updated: 0,
      existing: 0,
      snoozed: 0,
      creationCapped: 0,
      noActionSuppressed: 0,
      skipped: 0,
      failed: 0,
      reviewIssueIds: [reviews[0]!.id],
      failedIssueIds: [],
    });
    expect("ownerBurstDeferred" in result).toBe(false);
    expect(reviews[0]!.description).toContain("Primary trigger: `long_active_duration`");
    expect(reviews[0]!.description).toContain("- Current active elapsed time: 11h 0m");
    expect(reviews[0]!.description).not.toContain("Active execution time (netted");

    const createdLog = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.action, "issue.productivity_review_created"),
        ),
      );
    expect(createdLog).toHaveLength(1);
    expect(createdLog[0]!.details).toStrictEqual({
      source: "productivity_review.reconcile",
      sourceIssueId: seeded.issues.source.issueId,
      trigger: "long_active_duration",
      noCommentStreak: 8,
      runCountLastHour: 0,
      commentCountLastHour: 0,
    });
  });

  it("R1 paired on-leg: the Part 1 gate on does not fire the same fixture", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedNettedFixture(now);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { enableActiveExecutionDuration: true },
    });

    expect(result).toStrictEqual({
      scanned: 1,
      created: 0,
      updated: 0,
      existing: 0,
      snoozed: 0,
      creationCapped: 0,
      noActionSuppressed: 0,
      skipped: 1,
      failed: 0,
      reviewIssueIds: [],
      failedIssueIds: [],
    });
    expect(await listReviews(seeded.companyId)).toHaveLength(0);
  });

  it("R2: gate read from instance settings — on nets the queue out (no fire), off restores wall-clock (fires)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedNettedFixture(now);

    await instanceSettingsService(db).updateExperimental({
      enableProductivityReviewActiveExecutionDuration: true,
    });
    const gated = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    expect(gated.created).toBe(0);
    expect(gated.skipped).toBe(1);
    expect(await listReviews(seeded.companyId)).toHaveLength(0);

    await instanceSettingsService(db).updateExperimental({
      enableProductivityReviewActiveExecutionDuration: false,
    });
    const ungated = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    expect(ungated.created).toBe(1);
    expect(await listReviews(seeded.companyId)).toHaveLength(1);
  });

  it("R4: a single run wedged 7h in running state still fires under the gate", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * HOUR_MS);
    const seeded = await seedOrgWithIssues([
      { key: "wedged", startedAt: episodeStart, createdAt: episodeStart, updatedAt: episodeStart },
    ]);
    await insertRun({
      companyId: seeded.companyId,
      agentId: seeded.issues.wedged.coderId,
      issueId: seeded.issues.wedged.issueId,
      status: "running",
      startedAt: episodeStart,
      createdAt: new Date(episodeStart.getTime() - 5 * MINUTE_MS),
      updatedAt: new Date(now.getTime() - MINUTE_MS),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { enableActiveExecutionDuration: true },
    });

    expect(result.created).toBe(1);
    const reviews = await listReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("R7: a null episodeStart means no episode — no fire even with a 9h completed run", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedOrgWithIssues([
      {
        key: "no-episode",
        startedAt: null,
        createdAt: new Date(now.getTime() - 10 * HOUR_MS),
        updatedAt: new Date(now.getTime() - 10 * HOUR_MS),
      },
    ]);
    await insertRun({
      companyId: seeded.companyId,
      agentId: seeded.issues["no-episode"].coderId,
      issueId: seeded.issues["no-episode"].issueId,
      status: "succeeded",
      startedAt: new Date(now.getTime() - 9 * HOUR_MS),
      finishedAt: new Date(now.getTime() - 8 * HOUR_MS),
      createdAt: new Date(now.getTime() - 9 * HOUR_MS),
      updatedAt: new Date(now.getTime() - 8 * HOUR_MS),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { enableActiveExecutionDuration: true },
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listReviews(seeded.companyId)).toHaveLength(0);
  });

  async function seedFiveIssueBurst(now: Date) {
    const startedAt = new Date(now.getTime() - 7 * HOUR_MS);
    return seedOrgWithIssues(
      ["a", "b", "c", "d", "e"].map((key) => ({
        key,
        startedAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      })),
    );
  }

  it("R8: five same-owner candidates under cap 1 create one review and defer four", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedFiveIssueBurst(now);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { enableOwnerBurstCap: true },
    });

    const reviews = await listReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(result).toStrictEqual({
      scanned: 5,
      created: 1,
      updated: 0,
      existing: 0,
      snoozed: 0,
      creationCapped: 0,
      noActionSuppressed: 0,
      skipped: 0,
      failed: 0,
      ownerBurstDeferred: 4,
      reviewIssueIds: [reviews[0]!.id],
      failedIssueIds: [],
    });
    expect(reviews[0]!.assigneeAgentId).toBe(seeded.managerId);
  });

  it("R9: deferred candidates are created by subsequent sweeps — cumulative created 5, nothing dropped", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedFiveIssueBurst(now);
    const service = productivityReviewService(db);

    const deferredPerTick = [4, 3, 2, 1, 0];
    let cumulativeCreated = 0;
    for (let tick = 0; tick < 5; tick += 1) {
      const result = await service.reconcileProductivityReviews({
        now: new Date(now.getTime() + tick * MINUTE_MS),
        companyId: seeded.companyId,
        thresholds: { enableOwnerBurstCap: true },
      });
      expect(result.created).toBe(1);
      expect(result.ownerBurstDeferred).toBe(deferredPerTick[tick]);
      cumulativeCreated += result.created;
    }

    expect(cumulativeCreated).toBe(5);
    const reviews = await listReviews(seeded.companyId);
    expect(reviews).toHaveLength(5);
    expect(new Set(reviews.map((review) => review.originId)).size).toBe(5);
  });

  it("R10: the burst cap does not apply to the refresh path of an existing review", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedOrgWithIssues([
      {
        key: "with-review",
        startedAt: new Date(now.getTime() - 9 * HOUR_MS),
        createdAt: new Date(now.getTime() - 9 * HOUR_MS),
        updatedAt: new Date(now.getTime() - 2 * HOUR_MS),
      },
      {
        key: "fresh",
        startedAt: new Date(now.getTime() - 7 * HOUR_MS),
        createdAt: new Date(now.getTime() - 7 * HOUR_MS),
        updatedAt: new Date(now.getTime() - 3 * HOUR_MS),
      },
    ]);
    const reviewCreatedAt = new Date(now.getTime() - 2 * HOUR_MS);
    const existingReviewId = randomUUID();
    await db.insert(issues).values({
      id: existingReviewId,
      companyId: seeded.companyId,
      title: "Existing productivity review",
      status: "todo",
      priority: "medium",
      assigneeAgentId: seeded.managerId,
      parentId: seeded.issues["with-review"].issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issues["with-review"].issueId,
      originFingerprint: `productivity-review:${seeded.issues["with-review"].issueId}`,
      issueNumber: 3,
      identifier: `${seeded.issuePrefix}-3`,
      createdAt: reviewCreatedAt,
      updatedAt: reviewCreatedAt,
    });

    // "fresh" has the older updatedAt, so it is processed first and consumes
    // the owner's single creation slot before "with-review" reaches the
    // refresh path.
    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { enableOwnerBurstCap: true },
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.ownerBurstDeferred).toBe(0);
    expect(await listReviews(seeded.companyId)).toHaveLength(2);
    expect(await refreshCommentCount(existingReviewId)).toBe(1);
  });
});
