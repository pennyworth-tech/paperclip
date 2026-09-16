import { describe, expect, it } from "vitest";
import { pipelineStageApproverSchema } from "./pipeline.js";

describe("pipelineStageApproverSchema", () => {
  it("accepts linked_reviewer without an id", () => {
    expect(pipelineStageApproverSchema.parse({ kind: "linked_reviewer" })).toEqual({ kind: "linked_reviewer" });
  });

  it("still requires an id for user and agent approvers", () => {
    expect(pipelineStageApproverSchema.safeParse({ kind: "agent" }).success).toBe(false);
    expect(pipelineStageApproverSchema.safeParse({ kind: "user" }).success).toBe(false);
  });
});
