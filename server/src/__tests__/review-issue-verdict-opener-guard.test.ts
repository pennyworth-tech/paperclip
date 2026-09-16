/**
 * PR review verdict opener guard. Two surfaces:
 *
 *   1. Pure unit tests for `parseReviewVerdictOpener`, `isReviewIssueTitle`,
 *      and `firstNonBlankLine` — these run on every host because they are
 *      dependency-free.
 *
 *   2. Embedded-Postgres integration tests for `issueService.update` —
 *      cover every acceptance-criterion transition the issue names, plus
 *      three specimens observed in the field as regression cases.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import {
  firstNonBlankLine,
  isReviewIssueTitle,
  parseReviewVerdictOpener,
  REVIEW_VERDICT_OPENER_GUARD_CODE,
} from "../services/review-verdict-opener.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// 40-hex sha used throughout these tests. Any lowercase 40-char hex is fine.
const REVIEWED_SHA = "0123456789abcdef0123456789abcdef01234567";
const DIFFERENT_SHA = "fedcba9876543210fedcba9876543210fedcba98";

// Specimens observed in the field. Each carries agent terminal chrome and no
// verdict opener — exactly the defect the guard exists to catch.
const TERMINAL_CHROME_SPECIMENS = [
  // PR #208
  [
    "```",
    "  ⎿  Read 1 file (ctrl+o to expand)",
    "────────────────────────────────────────",
    "  ⎿  Loaded diff: 47 files, +1,201 -0",
    "...",
    "Build · model-a · worktree /home/dev/worktrees/example-os/eng-288",
    "Done — review complete.",
    "```",
  ].join("\n"),
  // PR #205
  [
    "Build · model-a",
    "Worktree: /home/dev/workspaces/example-os/eng-295",
    "─── tool call (truncated) ───",
    "gh pr diff 205  # cut off at line 4096",
    "─── end tool call ───",
    "PR looks fine; merging.",
  ].join("\n"),
  // A third specimen — same chrome, different sha/branch
  [
    "Build · model-a · worktree /home/dev/worktrees/example-os/eng-291-third",
    "Sessions: 3 active (idle, idle, running)",
    "Last tool: git_fetch(refs/pull/207/head) — exit 0",
    "No findings; review complete.",
  ].join("\n"),
];

describe("parseReviewVerdictOpener", () => {
  it("accepts APPROVE with em-dash and 40-hex sha", () => {
    expect(parseReviewVerdictOpener(`APPROVE — PR #208 at head ${REVIEWED_SHA}`)).toEqual({
      kind: "APPROVE",
      prNumber: 208,
      headSha: REVIEWED_SHA,
    });
  });

  it("accepts REQUEST CHANGES as a first-class verdict", () => {
    expect(parseReviewVerdictOpener(`REQUEST CHANGES — PR #205 at head ${REVIEWED_SHA}`)).toEqual({
      kind: "REQUEST CHANGES",
      prNumber: 205,
      headSha: REVIEWED_SHA,
    });
  });

  it("accepts NEEDS INFO as a first-class verdict, not a two-verdict regex", () => {
    const opener = parseReviewVerdictOpener(`NEEDS INFO — PR #205 at head ${REVIEWED_SHA}`);
    expect(opener).toEqual({
      kind: "NEEDS INFO",
      prNumber: 205,
      headSha: REVIEWED_SHA,
    });
    // The two-verdict regex form (^(APPROVE|REQUEST CHANGES)) would refuse this
    // and push reviewers toward inventing an APPROVE just to close the issue,
    // which is strictly worse than the defect being fixed. The implementation
    // regex above (the three-verdict form) is the binding assertion: if it ever
    // narrows to two verdicts, the `toEqual` above fails on `kind`. No second
    // assertion against an inline literal is needed (and adding one would test
    // that literal against itself, not the implementation).
  });

  it("rejects opener with non-em-dash separator (spec is em-dash U+2014)", () => {
    expect(parseReviewVerdictOpener(`APPROVE - PR #208 at head ${REVIEWED_SHA}`)).toBeNull();
    expect(parseReviewVerdictOpener(`APPROVE -- PR #208 at head ${REVIEWED_SHA}`)).toBeNull();
    expect(parseReviewVerdictOpener(`APPROVE: PR #208 at head ${REVIEWED_SHA}`)).toBeNull();
  });

  it("rejects opener with abbreviated or non-40-char sha", () => {
    expect(parseReviewVerdictOpener(`APPROVE — PR #208 at head abc1234`)).toBeNull();
    expect(parseReviewVerdictOpener(`APPROVE — PR #208 at head ${REVIEWED_SHA}deadbeef`)).toBeNull();
    // 39 chars (missing one)
    const tooShort = REVIEWED_SHA.slice(1);
    expect(parseReviewVerdictOpener(`APPROVE — PR #208 at head ${tooShort}`)).toBeNull();
  });

  it("rejects opener that names no PR number", () => {
    expect(parseReviewVerdictOpener(`APPROVE — PR at head ${REVIEWED_SHA}`)).toBeNull();
  });

  it("rejects opener that names no head", () => {
    expect(parseReviewVerdictOpener(`APPROVE — PR #208`)).toBeNull();
    expect(parseReviewVerdictOpener(`APPROVE — PR #208 at head not-a-sha`)).toBeNull();
  });

  it("rejects an unknown verdict kind", () => {
    expect(parseReviewVerdictOpener(`LGTM — PR #208 at head ${REVIEWED_SHA}`)).toBeNull();
    expect(parseReviewVerdictOpener(`SHIP IT — PR #208 at head ${REVIEWED_SHA}`)).toBeNull();
  });

  it("rejects a case-mangled verdict kind (spec is uppercase)", () => {
    // Deliberately case-sensitive: the title contract is upper-case so a
    // sloppy `Approve — PR #N at head <sha>` would survive a lenient matcher
    // and quietly fail the freshness check downstream.
    expect(parseReviewVerdictOpener(`Approve — PR #208 at head ${REVIEWED_SHA}`)).toBeNull();
  });

  it("ignores leading and trailing whitespace on the opener line", () => {
    expect(parseReviewVerdictOpener(`  APPROVE — PR #208 at head ${REVIEWED_SHA}  `)).toEqual({
      kind: "APPROVE",
      prNumber: 208,
      headSha: REVIEWED_SHA,
    });
  });

  it("returns null for empty input", () => {
    expect(parseReviewVerdictOpener("")).toBeNull();
    expect(parseReviewVerdictOpener("   ")).toBeNull();
  });
});

describe("firstNonBlankLine", () => {
  it("returns the first line that has any non-whitespace content", () => {
    expect(firstNonBlankLine("\n\n   \nAPPROVE — PR #208 at head abcd\nbody")).toBe(
      `APPROVE — PR #208 at head abcd`,
    );
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(firstNonBlankLine("\n\n   \n")).toBe("");
    expect(firstNonBlankLine("")).toBe("");
  });
});

describe("isReviewIssueTitle", () => {
  it("matches every canonical title shape from docs/pr-review-path.md §2", () => {
    expect(isReviewIssueTitle("Review PR #208 (example-os) — add the verdict opener guard, head 0123abcd")).toBe(true);
    expect(isReviewIssueTitle("Review PR #208 (example-os) — add the verdict opener guard")).toBe(true);
    expect(isReviewIssueTitle("Re-review PR #208 (example-os) — delta after the merge, head 0123abcd")).toBe(true);
    expect(isReviewIssueTitle("Re-verify PR #208 (example-os) — re-verify the false-positive test, head 0123abcd")).toBe(true);
  });

  it("matches the legacy role-prefixed and id-prefixed shapes the dedup regex covers", () => {
    expect(isReviewIssueTitle("QA Lead: review PR #158 (example-os) — the long one")).toBe(true);
    expect(isReviewIssueTitle("Review ENG-26 spec (PR #154): the mailer claim")).toBe(true);
  });

  it("does NOT match a generic PR-touching issue that is not a review", () => {
    expect(isReviewIssueTitle("Land PR #163 and record ENG-65's disposition")).toBe(false);
    expect(isReviewIssueTitle("Merge PR #160 (example-os) — production deploy")).toBe(false);
    expect(isReviewIssueTitle("ENG-149: ship the panel roster fix")).toBe(false);
    expect(isReviewIssueTitle("Resolve flake in PR #205 CI")).toBe(false);
  });

  it("does NOT match an issue that mentions a review verb but no PR number", () => {
    expect(isReviewIssueTitle("Review the regression-test plan")).toBe(false);
    expect(isReviewIssueTitle("Spec review for the new approval flow")).toBe(false);
  });

  it("does NOT match a non-review issue that happens to use the word 'review'", () => {
    // `preview` contains the substring `review`, so a naive `re-?view` matcher
    // would misfire. The word-boundary regex catches that.
    expect(isReviewIssueTitle("Preview the deploy plan")).toBe(false);
    expect(isReviewIssueTitle("Survey the run-log file")).toBe(false);
  });

  // The previous predicate matched a review verb ANYWHERE in the title and so
  // admitted live false positives — six were observed in one corpus, two in
  // flight and four completed. Anchoring the verb at the start of the title
  // (with tolerance for a short "<role>: " prefix) drops all six while still
  // recognising every canonical review title in that corpus. These cases
  // fail-before / pass-after on the previous predicate.
  it("does NOT match prose-verb false positives (anchored predicate)", () => {
    // The two in-flight false positives that survived the previous predicate.
    expect(isReviewIssueTitle(
      "Pin PR #174's transient-blocked streaming-liveness ordering with a test, and clear four review nits",
    )).toBe(false);
    expect(isReviewIssueTitle(
      "Overlay housekeeping from the PR #159 review: example-os",
    )).toBe(false);

    // The same family with an issue-id prefix — also rejected; the role-prefix
    // strip is bounded so a leading "ENG-126:" prefix is stripped, but the
    // stripped remainder "Pin PR #174's …" still does not start with a review verb.
    expect(isReviewIssueTitle(
      "ENG-126: Pin PR #174's transient-blocked streaming-liveness ordering with a test, and clear four review nits",
    )).toBe(false);
    expect(isReviewIssueTitle(
      "ENG-91: Overlay housekeeping from the PR #159 review: example-os",
    )).toBe(false);

    // Completed relay/follow-up issues from the same corpus — same shape,
    // predicate blast radius does not care whether the issue is in flight or done.
    expect(isReviewIssueTitle(
      "Relay PR #208 verdict ENG-65",
    )).toBe(false);
    expect(isReviewIssueTitle(
      "Relay the completed 158 approve verdict onto ENG-52",
    )).toBe(false);
    expect(isReviewIssueTitle(
      "Do not widen the verdict-opener parser per the ENG-309 review",
    )).toBe(false);
  });

  it("DOES match the canonical spec-review hybrid shape (PR-anchored)", () => {
    // In "Review ENG-26 spec (PR #154): …" the role-prefix strip is viable but
    // its remainder does not start with a review verb, so the engine falls back
    // to the no-prefix alternative and matches the literal verb "Review" at
    // index 0. The anchored predicate must keep accepting this shape.
    expect(isReviewIssueTitle(
      "Review ENG-26 spec (PR #154): the mailer claim",
    )).toBe(true);
    expect(isReviewIssueTitle(
      "Review ENG-185 spec (PR #184): the wake-payload staleness contract",
    )).toBe(true);
  });

  it("DOES match the role-prefixed legacy shape with parens", () => {
    // A role display name may contain parens. The 48-char role-prefix bound
    // admits it: the prefix is well inside the bound, and the remainder starts
    // with the review verb.
    expect(isReviewIssueTitle(
      "Dev Spec Review (model-b): review PR #226 (example-os) — verdict for the guard",
    )).toBe(true);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review-issue verdict opener tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.update — PR review verdict opener guard", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let settingsService!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-guard-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    settingsService = instanceSettingsService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndReviewer() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Example Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "QA Lead",
      role: "reviewer",
      status: "active",
      reportsTo: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, reviewerAgentId };
  }

  async function enableGuard() {
    // The row is upserted by `getOrCreateRow`; flip the experimental flag and
    // let `normalizeExperimentalSettings` read it back on the next call.
    const current = await settingsService.get();
    const experimental = { ...current.experimental, requireReviewIssueVerdictOpener: true };
    await db
      .update(instanceSettings)
      .set({ experimental, updatedAt: new Date() })
      .where(eq(instanceSettings.id, current.id));
  }

  function approveOpenerFor(prNumber: number, sha: string = REVIEWED_SHA) {
    return `APPROVE — PR #${prNumber} at head ${sha}`;
  }

  function changesOpenerFor(prNumber: number, sha: string = REVIEWED_SHA) {
    return `REQUEST CHANGES — PR #${prNumber} at head ${sha}`;
  }

  function needsInfoOpenerFor(prNumber: number, sha: string = REVIEWED_SHA) {
    return `NEEDS INFO — PR #${prNumber} at head ${sha}`;
  }

  async function addReviewerComment(
    companyId: string,
    issueId: string,
    reviewerAgentId: string,
    body: string,
  ) {
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      authorUserId: null,
      authorType: "agent",
      body,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("flag defaults off — review issues close without a verdict opener", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });

    // Default setting is `false`: closing works without a verdict opener.
    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("blocks a review issue with no comments when the flag is on (the defect)", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();

    await expect(
      svc.update(issue.id, { status: "done", actorAgentId: reviewerAgentId }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: REVIEW_VERDICT_OPENER_GUARD_CODE,
        reason: "no_conforming_verdict_opener",
        issueId: issue.id,
        assigneeAgentId: reviewerAgentId,
        commentsChecked: 0,
      },
    });
  });

  it("blocks the terminal-chrome specimens verbatim — three regression cases from the field", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const titles = [
      "Review PR #208 (example-os) — ENG-288 fix, head 0123abcd",
      "Re-review PR #205 (example-os) — ENG-295 delta, head 0123abcd",
      "Re-verify PR #207 (example-os) — ENG-291 third specimen, head 0123abcd",
    ];
    await enableGuard();

    for (let i = 0; i < titles.length; i += 1) {
      const title = titles[i]!;
      const chromeBody = TERMINAL_CHROME_SPECIMENS[i]!;
      const issue = await svc.create(companyId, {
        title,
        description: null,
        status: "todo",
        priority: "high",
        assigneeAgentId: reviewerAgentId,
      });
      await addReviewerComment(companyId, issue.id, reviewerAgentId, chromeBody);

      await expect(
        svc.update(issue.id, { status: "done", actorAgentId: reviewerAgentId }),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: REVIEW_VERDICT_OPENER_GUARD_CODE,
          reason: "no_conforming_verdict_opener",
        },
      });

      // Status must not have changed.
      const after = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issue.id)).then((r) => r[0]);
      expect(after?.status).toBe("todo");
    }
  });

  it("accepts a conforming APPROVE — the standard happy path", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    await addReviewerComment(companyId, issue.id, reviewerAgentId, approveOpenerFor(208));

    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("accepts a conforming REQUEST CHANGES — the verdict is the deliverable", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #205 (example-os) — second-look at the merge, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    await addReviewerComment(
      companyId,
      issue.id,
      reviewerAgentId,
      [
        changesOpenerFor(205),
        "",
        "Concrete failing input: the guard's predicate does not match the legacy `Review ENG-… spec (PR #N): …` shape.",
      ].join("\n"),
    );

    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("accepts NEEDS INFO — a first-class abstention, not a two-verdict regex", async () => {
    // The two-verdict regex form `^(APPROVE|REQUEST CHANGES)` would refuse this
    // and push reviewers toward inventing an APPROVE just to close the issue.
    // This test pins that the guard never takes that shape.
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #205 (example-os) — short context, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    await addReviewerComment(
      companyId,
      issue.id,
      reviewerAgentId,
      [
        needsInfoOpenerFor(205),
        "",
        "The review issue did not carry the spec; I cannot reach a verdict.",
      ].join("\n"),
    );

    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("requires the verdict opener to be on the FIRST non-blank line, not later", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    // Chrome above the verdict — this is exactly what the docs say not to do.
    await addReviewerComment(
      companyId,
      issue.id,
      reviewerAgentId,
      [
        "```",
        "  ⎿  Loaded diff: 47 files, +1,201 -0",
        "Build · model-a",
        "```",
        "",
        approveOpenerFor(208),
      ].join("\n"),
    );

    await expect(
      svc.update(issue.id, { status: "done", actorAgentId: reviewerAgentId }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: REVIEW_VERDICT_OPENER_GUARD_CODE },
    });
  });

  it("requires the verdict comment to be authored by the assigned reviewer", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other Agent",
      role: "engineer",
      status: "active",
      reportsTo: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    // A different agent wrote a perfect verdict opener — still rejected, the
    // authorship predicate is structural.
    await addReviewerComment(companyId, issue.id, otherAgentId, approveOpenerFor(208));

    await expect(
      svc.update(issue.id, { status: "done", actorAgentId: reviewerAgentId }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: REVIEW_VERDICT_OPENER_GUARD_CODE },
    });
  });

  it("recognises the reviewer's verdict when authorship was backfilled to a derivedAuthorAgentId", async () => {
    // Attribution backfill: a comment whose `authorAgentId` is null
    // but whose `derivedAuthorAgentId` resolves to the reviewer is still
    // theirs. The guard must accept the verdict in that case so the
    // backfilled comments don't get treated as untrusted.
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    await db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: null,
      authorUserId: "local-board",
      authorType: "user",
      derivedAuthorAgentId: reviewerAgentId,
      derivedAuthorSource: "run_log_comment_post",
      body: approveOpenerFor(208),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("does not apply to a non-review issue even when the flag is on", async () => {
    // Acceptance criterion: "Non-review issues are untouched."
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "ENG-149: ship the panel roster fix",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    // No verdict opener anywhere on the issue — close still succeeds because
    // the title is not a review issue.
    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("does not apply to a landing issue whose title contains `PR #<n>` and `review` incidentally", async () => {
    // Belt-and-braces for the predicate's blast radius: a landing issue that
    // mentions a review in prose but is not a review issue must close cleanly.
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Land PR #163 and record ENG-65's disposition",
      description: "Closing out the review for the merge train.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("does not fire on transitions other than into `done`", async () => {
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();

    const updated = await svc.update(issue.id, {
      status: "in_progress",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("in_progress");
  });

  it("refuses when the title is a review shape but the issue has no reviewer (defensive)", async () => {
    // Defensive: a review-shaped title without an assigned reviewer means the
    // guard cannot verify authorship, and refusing the close is the safer
    // failure mode than silently letting a chrome-only close through.
    const { companyId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: null,
    });
    await enableGuard();

    await expect(
      svc.update(issue.id, { status: "done", actorUserId: "local-board" }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: REVIEW_VERDICT_OPENER_GUARD_CODE, reason: "no_reviewer" },
    });
  });

  it("different sha than the title — the opener's sha is the only thing checked", async () => {
    // Freshness is the sweep's job, not the guard's. The guard must accept
    // an opener that names a sha different from the title's; rejecting here
    // would conflate two responsibilities and silently re-introduce the
    // the same defect under a different failure mode.
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    await addReviewerComment(companyId, issue.id, reviewerAgentId, approveOpenerFor(208, DIFFERENT_SHA));

    const updated = await svc.update(issue.id, {
      status: "done",
      actorAgentId: reviewerAgentId,
    });
    expect(updated?.status).toBe("done");
  });

  it("non-em-dash separator is treated as a non-conforming opener", async () => {
    // Pins the spec's em-dash (U+2014). A reviewer who writes ASCII `-` would
    // currently be refused — that is the spec's contract; widening the parser
    // is a separate decision, not a silent drift.
    const { companyId, reviewerAgentId } = await seedCompanyAndReviewer();
    const issue = await svc.create(companyId, {
      title: "Review PR #208 (example-os) — fix the run-engine bug, head 0123abcd",
      description: null,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
    });
    await enableGuard();
    await addReviewerComment(companyId, issue.id, reviewerAgentId, `APPROVE - PR #208 at head ${REVIEWED_SHA}`);

    await expect(
      svc.update(issue.id, { status: "done", actorAgentId: reviewerAgentId }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: REVIEW_VERDICT_OPENER_GUARD_CODE },
    });
  });
});
