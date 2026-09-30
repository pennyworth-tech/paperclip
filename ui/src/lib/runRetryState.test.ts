import { describe, expect, it } from "vitest";
import { describeRunSupersession, describeRunRetryState, formatRetryReason } from "./runRetryState";

describe("runRetryState", () => {
  it("formats internal retry reasons for operators", () => {
    expect(formatRetryReason("transient_failure")).toBe("Transient failure");
    expect(formatRetryReason("issue_continuation_needed")).toBe("Continuation needed");
    expect(formatRetryReason("max_turns_continuation")).toBe("Max-turn continuation");
    expect(formatRetryReason("custom_reason")).toBe("custom reason");
  });

  it("describes scheduled retries", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Retry scheduled",
      detail: "Attempt 2 · Transient failure",
    });
  });

  it("describes max-turn continuation retries distinctly", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-max-turns",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "max_turns_continuation",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Continuation scheduled",
      detail: "Attempt 1 · Max-turn continuation",
    });
  });

  it("describes exhausted retries", () => {
    expect(
      describeRunRetryState({
        status: "failed",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
        retryExhaustedReason: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      }),
    ).toMatchObject({
      kind: "exhausted",
      badgeLabel: "Retry exhausted",
      detail: "Attempt 4 · Transient failure · Automatic retries exhausted",
      secondary: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued Manual intervention required.",
    });
  });
});

describe("pre-execution supersession", () => {
  const cancelled = {
    status: "cancelled", errorCode: "issue_preparation_turn_changed", startedAt: null,
    exitCode: null, logRef: null, logBytes: null, usageJson: null,
    stdoutExcerpt: null, stderrExcerpt: null,
  };
  it.each(["issue_preparation_turn_changed", "issue_assignee_changed", "issue_terminal_status",
    "issue_execution_lock_changed", "issue_review_participant_changed"])("explains %s without hiding its audit code", (errorCode) => {
    expect(describeRunSupersession({ ...cancelled, errorCode })).toEqual({
      label: "Superseded before it started",
      detail: "No action needed. The task lifecycle no longer permits this queued run.",
      errorCode,
    });
  });
  it.each([
    { status: "failed" }, { startedAt: new Date() }, { exitCode: 1 }, { exitCode: 0 },
    { logRef: "run.log" }, { logBytes: 12 }, { usageJson: {} },
    { stdoutExcerpt: "started" }, { stderrExcerpt: "crashed" },
    { errorCode: "adapter_failed" }, { errorCode: "cancelled_by_operator" }, { errorCode: null },
  ])("does not mask failures, executed runs or operator cancellation: %j", (override) => {
    expect(describeRunSupersession({ ...cancelled, ...override })).toBeNull();
  });
});
