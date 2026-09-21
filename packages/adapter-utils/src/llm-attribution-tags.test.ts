import { describe, expect, it } from "vitest";
import { buildLlmAttributionTags } from "./server-utils.js";

describe("buildLlmAttributionTags", () => {
  it("names the agent, the issue's human identifier and the stage", () => {
    const tags = buildLlmAttributionTags({
      agent: { name: "Reviewer" },
      context: {
        issueId: "0b2c7d1e-issue-uuid",
        paperclipWake: { reason: "issue_assigned", issue: { id: "0b2c7d1e-issue-uuid", identifier: "PRJ-12" } },
        stageKey: "review",
      },
    });

    expect(tags).toBe("agent:Reviewer,issue:PRJ-12,stage:review");
  });

  it("falls back from the wake identifier to the issue snapshot, then the raw ids", () => {
    expect(
      buildLlmAttributionTags({
        agent: { name: "a" },
        context: { paperclipIssue: { identifier: "PRJ-7" }, issueId: "uuid-7" },
      }),
    ).toBe("agent:a,issue:PRJ-7,stage:none");
    expect(buildLlmAttributionTags({ agent: { name: "a" }, context: { issueId: "uuid-7" } })).toBe(
      "agent:a,issue:uuid-7,stage:none",
    );
    expect(buildLlmAttributionTags({ agent: { name: "a" }, context: { taskId: "task-9" } })).toBe(
      "agent:a,issue:task-9,stage:none",
    );
  });

  it("tags `none` for a wake with no issue and a run with no stage", () => {
    // A timer or heartbeat wake carries neither; the tag names are still
    // present so a spend query sees the same shape on every row.
    expect(buildLlmAttributionTags({ agent: { name: "Ops" }, context: { wakeReason: "timer" } })).toBe(
      "agent:Ops,issue:none,stage:none",
    );
    expect(buildLlmAttributionTags({ agent: {}, context: {} })).toBe("agent:none,issue:none,stage:none");
  });

  it("keeps a value inside the header-safe alphabet", () => {
    // Spaces, commas and colons would split or reshape the comma-separated
    // `name:value` list; they collapse to one dash and edges are trimmed.
    expect(
      buildLlmAttributionTags({
        agent: { name: "Code Reviewer B" },
        context: { paperclipWake: { issue: { identifier: " PRJ-12, urgent: yes " } }, stageKey: "code:review" },
      }),
    ).toBe("agent:Code-Reviewer-B,issue:PRJ-12-urgent-yes,stage:code-review");
  });

  it("caps a value at 64 characters", () => {
    const tags = buildLlmAttributionTags({ agent: { name: "x".repeat(100) }, context: {} });
    expect(tags.startsWith(`agent:${"x".repeat(64)},`)).toBe(true);
    expect(tags).toBe(`agent:${"x".repeat(64)},issue:none,stage:none`);
  });

  it("ignores non-string values rather than throwing", () => {
    expect(
      buildLlmAttributionTags({ agent: { name: 42 }, context: { issueId: ["not", "a", "string"], stageKey: null } }),
    ).toBe("agent:none,issue:none,stage:none");
    expect(buildLlmAttributionTags({ agent: { name: "a" }, context: "not an object" })).toBe(
      "agent:a,issue:none,stage:none",
    );
  });
});
