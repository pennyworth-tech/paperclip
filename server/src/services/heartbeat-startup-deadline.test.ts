import { describe, expect, it } from "vitest";
import { legacyStartupDeadlineExpired, LEGACY_STARTUP_DEADLINE_MS } from "./heartbeat-startup-deadline.js";
const start = new Date("2026-09-01T00:00:00Z");
const silent = { runtimeMode: "legacy", startedAt: start, processStartedAt: null, processPid: null, processGroupId: null, lastOutputAt: null };
const expired = new Date(start.getTime() + LEGACY_STARTUP_DEADLINE_MS);
describe("legacy startup cancellation deadline", () => {
  it("requests a stop only once a silent legacy startup reaches the deadline", () => {
    expect(legacyStartupDeadlineExpired(silent, new Date(expired.getTime() - 1))).toBe(false);
    expect(legacyStartupDeadlineExpired(silent, expired)).toBe(true);
  });
  it.each([
    { runtimeMode: "native" }, { runtimeMode: null }, { startedAt: null },
    { startedAt: "invalid" }, { processStartedAt: start }, { processPid: 123 },
    { processGroupId: 123 }, { lastOutputAt: start },
  ])("does not treat native ownership, missing claim time or execution evidence as a silent legacy startup: %j", (patch) => {
    expect(legacyStartupDeadlineExpired({ ...silent, ...patch }, expired)).toBe(false);
  });
});
