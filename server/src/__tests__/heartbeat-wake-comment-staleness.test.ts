import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildPaperclipWakePayload,
  mergeCoalescedContextSnapshot,
} from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake comment staleness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The inlined comment set in a wake payload is an id-delta resolved from the
// wake comment ids a run absorbed, never a view of the issue thread. A comment
// consumed by an EARLIER wake is therefore structurally absent from a LATER
// run's payload -- a production failure, where a "PR is approved, do not rebuild
// it" relay was invisible to the run that needed it while
// GET /api/issues/{id}/comments returned it fine.
//
// These tests pin the remedy: the payload states its own composition time and
// the live thread size, so a reader can tell its view is partial.
describeEmbeddedPostgres("wake payload comment staleness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-staleness-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Wake Staleness Co",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "WAKE-1",
      title: "Wake payload comment staleness",
      status: "in_progress",
      priority: "high",
    });
    return { companyId, issueId };
  }

  async function addComment(companyId: string, issueId: string, body: string) {
    const id = randomUUID();
    await db.insert(issueComments).values({ id, companyId, issueId, body });
    return id;
  }

  it("reports the live thread size when a comment lands between enqueue and dispatch", async () => {
    const { companyId, issueId } = await seedIssue();

    // Enqueue: one comment wakes the run, so its id is what the snapshot carries.
    const enqueuedCommentId = await addComment(companyId, issueId, "first wake comment");
    const contextSnapshot: Record<string, unknown> = {
      wakeReason: "issue_commented",
      issueId,
      commentId: enqueuedCommentId,
      wakeCommentIds: [enqueuedCommentId],
    };

    // ...then a second comment is posted before this run is dispatched. It woke
    // (or will wake) a different run, so it never joins this snapshot's id list.
    await addComment(companyId, issueId, "PR is approved, do not rebuild it");

    // Dispatch: buildPaperclipWakePayload runs on the executeRun path.
    const payload = await buildPaperclipWakePayload({ db, companyId, contextSnapshot });

    // The delta itself is unchanged -- only the comment that woke this run is inlined.
    expect(payload?.comments).toHaveLength(1);
    expect(payload?.commentIds).toEqual([enqueuedCommentId]);

    // ...but the payload now says so. includedCount < issueCommentTotal is the
    // signal that this is a partial view and the thread must be fetched.
    expect(payload?.commentWindow).toMatchObject({
      requestedCount: 1,
      includedCount: 1,
      missingCount: 0,
      issueCommentTotal: 2,
    });
    expect(payload!.commentWindow.includedCount).toBeLessThan(
      payload!.commentWindow.issueCommentTotal!,
    );

    // Composition happens at dispatch, so the stamp is a dispatch-time stamp.
    expect(typeof payload?.composedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload!.composedAt as string))).toBe(false);
  });

  it("exposes a thread an assignment wake carries no comment ids for", async () => {
    const { companyId, issueId } = await seedIssue();
    await addComment(companyId, issueId, "earlier instruction consumed by a previous run");
    await addComment(companyId, issueId, "its acknowledgement");

    // An issue_assigned wake carries no comment ids at all: the delta is empty
    // while the thread holds two comments. Without the live count this payload
    // is indistinguishable from a genuinely empty thread.
    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: { wakeReason: "issue_assigned", issueId },
    });

    expect(payload?.comments).toEqual([]);
    expect(payload?.commentWindow).toMatchObject({
      requestedCount: 0,
      includedCount: 0,
      issueCommentTotal: 2,
    });
  });

  it("counts the same rows the issue comment thread endpoint returns", async () => {
    const { companyId, issueId } = await seedIssue();
    const commentId = await addComment(companyId, issueId, "a comment later deleted");
    await db
      .update(issueComments)
      .set({ deletedAt: new Date(), deletedByType: "user" })
      .where(sql`${issueComments.id} = ${commentId}`);

    // issuesSvc.listComments is issue-scoped and does not filter tombstones, so
    // the count must include them -- otherwise a reader comparing against
    // GET /api/issues/{id}/comments would see a phantom mismatch.
    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: { wakeReason: "issue_assigned", issueId },
    });

    expect(payload?.commentWindow.issueCommentTotal).toBe(1);
  });

  it("leaves the live count null when the wake carries no issue", async () => {
    const payload = await buildPaperclipWakePayload({
      db,
      companyId: randomUUID(),
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: "hello",
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(payload?.commentWindow.issueCommentTotal).toBeNull();
  });

  it("drops a cached payload when neither side of a coalesce carries comment ids", () => {
    // Invalidation used to be conditional on the merged id list being non-empty.
    // When a run queued by a comment wake coalesces, the existing snapshot still
    // carries ids and the cached payload was dropped -- so the hole only opens
    // when NEITHER side has comment ids: a run queued by an assignment wake
    // (payload built from the issue summary alone) that a status-change or
    // recovery wake then coalesces onto. That left a stale payload in place.
    const merged = mergeCoalescedContextSnapshot(
      { wakeReason: "issue_assigned", paperclipWake: { issue: { status: "todo" } } },
      { wakeReason: "issue_status_changed" },
    );

    expect(merged.paperclipWake).toBeUndefined();
    expect(merged.wakeReason).toBe("issue_status_changed");

    // The comment-carrying case keeps its existing behaviour.
    const mergedWithIds = mergeCoalescedContextSnapshot(
      { wakeCommentIds: ["comment-1"], paperclipWake: { comments: [{ id: "comment-1" }] } },
      { wakeReason: "issue_assigned" },
    );
    expect(mergedWithIds.paperclipWake).toBeUndefined();
    expect(mergedWithIds.wakeCommentIds).toEqual(["comment-1"]);
  });
});
