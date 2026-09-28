import { describe, expect, it } from "vitest";
import { summarizeCaseWorkExecution } from "../services/pipeline-case-work-execution.js";

describe("durable preparation execution receipts", () => {
  it("keeps missed and skipped wakes distinct from an active or completed assignment", () => {
    expect(summarizeCaseWorkExecution([], []).state).toBe("not_requested");
    expect(summarizeCaseWorkExecution([{ id: "skip", runId: null, status: "skipped" }], []).state).toBe("not_requested");
    expect(summarizeCaseWorkExecution([{ id: "wake", runId: null, status: "deferred_issue_execution" }], []).state).toBe("pending");
  });
  it("does not treat native scheduled retries or unknown statuses as ended runs", () => {
    expect(summarizeCaseWorkExecution([], [{ id: "retry", status: "scheduled_retry", wakeupRequestId: null }]).state).toBe("active");
    expect(summarizeCaseWorkExecution([], [{ id: "unknown", status: "new-host-status", wakeupRequestId: null }]).state).toBe("unknown");
  });
  it("requires every recorded assignment to be terminal, including continuations", () => {
    const completed = { id: "done", status: "failed", wakeupRequestId: "wake" };
    const request = { id: "wake", status: "completed", runId: "done" };
    expect(summarizeCaseWorkExecution([request], [completed]).state).toBe("terminal");
    expect(summarizeCaseWorkExecution([request], [completed, { id: "continued", status: "running", wakeupRequestId: null }]).state).toBe("active");
    expect(summarizeCaseWorkExecution([request, { id: "missing", runId: "lost-run", status: "completed" }], [completed]).state).toBe("unknown");
  });
  it("joins the native wakeup foreign key even before the request's run ID was projected", () => {
    expect(summarizeCaseWorkExecution([{ id: "wake", status: "claimed", runId: null }],
      [{ id: "ended", status: "interrupted", wakeupRequestId: "wake" }])).toMatchObject({ state: "terminal", runIds: ["ended"] });
  });
});
