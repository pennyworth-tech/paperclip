import { describe, expect, it } from "vitest";
import { bulkReviewSchema, reviewCaseSchema, transitionCaseSchema } from "./pipelines-schemas.js";

const evidenceId = "11111111-2222-4333-8444-555555555555";

describe("pipeline decision evidence at the REST boundary", () => {
  it("preserves the observed evidence ID for transitions and reviews", () => {
    expect(transitionCaseSchema.parse({ toStageKey: "done", expectedVersion: 7, evidenceId }).evidenceId)
      .toBe(evidenceId);
    expect(reviewCaseSchema.parse({ decision: "approve", expectedVersion: 7, evidenceId }).evidenceId)
      .toBe(evidenceId);
    expect(bulkReviewSchema.parse({ items: [{ caseId: evidenceId, decision: "approve", expectedVersion: 7, evidenceId }] })
      .items[0]?.evidenceId).toBe(evidenceId);
  });

  it("rejects malformed evidence without requiring it for unprotected stages", () => {
    const review = { decision: "approve", expectedVersion: 7 };
    expect(reviewCaseSchema.safeParse(review).success).toBe(true);
    expect(reviewCaseSchema.safeParse({ ...review, evidenceId: null }).success).toBe(true);
    expect(reviewCaseSchema.safeParse({ ...review, evidenceId: "stale-reference" }).success).toBe(false);
    expect(transitionCaseSchema.safeParse({ toStageKey: "done", expectedVersion: 7, evidenceId: "bad" }).success)
      .toBe(false);
  });
});
