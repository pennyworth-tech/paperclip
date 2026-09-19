import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_CHECKPOINT_EVENT_TYPE,
  SESSION_RECOVERY_EVENT_TYPE,
  buildClaudeTranscriptProbePath,
  createStreamSessionIdLatch,
  type SessionCheckpointPayload,
} from "./session-checkpoint.js";

// A stand-in for the three real adapter parsers: a pure line loop that skips
// unparseable lines and reports the first session id it finds. The point of the
// fixture is the partial-line behaviour, which is what the latch relies on.
function parseFixtureJsonl(buffer: string): { sessionId: string | null } {
  let sessionId: string | null = null;
  for (const rawLine of buffer.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const id = typeof event.session_id === "string" ? event.session_id : "";
      if (id) sessionId = id;
    } catch {
      // partial trailing line; a later chunk completes it
    }
  }
  return { sessionId };
}

describe("session checkpoint wire contract", () => {
  // These literals are duplicated on the host sink by design. Pin them so a
  // rename here cannot silently desynchronize the two halves.
  it("pins the event type literals", () => {
    expect(SESSION_CHECKPOINT_EVENT_TYPE).toBe("session.checkpoint");
    expect(SESSION_RECOVERY_EVENT_TYPE).toBe("session.recovery");
  });

  // Without `source` the three-outcome contract is not classifiable from a
  // checkpoint: a caller-supplied id whose transcript never appeared is
  // outcome 1 (nothing was ever created), while a harness-named id that has
  // gone missing is outcome 3 (a session existed and is lost). Both look
  // identical in the stored session params, so the distinction has to ride on
  // the event.
  it("carries the provenance of the checkpointed id", () => {
    const minted: SessionCheckpointPayload = {
      attempt: 1,
      sessionId: "s1",
      sessionParams: { sessionId: "s1" },
      source: "minted",
    };
    const streamed: SessionCheckpointPayload = { ...minted, source: "stream" };

    expect(minted.source).toBe("minted");
    expect(streamed.source).toBe("stream");
  });
});

describe("createStreamSessionIdLatch", () => {
  it("fires once on the first session id and ignores later ids", () => {
    const onSessionId = vi.fn();
    const latch = createStreamSessionIdLatch({ parse: parseFixtureJsonl, onSessionId });

    latch.push(`${JSON.stringify({ type: "init", session_id: "session-a" })}\n`);
    latch.push(`${JSON.stringify({ type: "message", session_id: "session-b" })}\n`);

    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith("session-a");
    expect(latch.sessionId).toBe("session-a");
  });

  // The whole reason the latch re-parses the accumulated buffer instead of
  // splitting lines itself: a chunk boundary can land in the middle of a JSON
  // object, and none of the three adapter parsers know about chunk boundaries.
  it("recovers a session id split across two chunks", () => {
    const onSessionId = vi.fn();
    const latch = createStreamSessionIdLatch({ parse: parseFixtureJsonl, onSessionId });
    const line = JSON.stringify({ type: "init", session_id: "session-split" });

    latch.push(line.slice(0, 18));
    expect(onSessionId).not.toHaveBeenCalled();

    latch.push(`${line.slice(18)}\n`);
    expect(onSessionId).toHaveBeenCalledExactlyOnceWith("session-split");
  });

  it("does not fire for a stream that never names a session", () => {
    const onSessionId = vi.fn();
    const latch = createStreamSessionIdLatch({ parse: parseFixtureJsonl, onSessionId });

    latch.push(`${JSON.stringify({ type: "message" })}\n`);
    latch.push("not json at all\n");

    expect(onSessionId).not.toHaveBeenCalled();
    expect(latch.sessionId).toBeNull();
  });

  // Claude knows its session id before the child produces output, so the latch
  // is pre-settled and the stream must not emit a second, duplicate checkpoint.
  it("settle() closes the latch without firing", () => {
    const onSessionId = vi.fn();
    const latch = createStreamSessionIdLatch({ parse: parseFixtureJsonl, onSessionId });

    latch.settle("minted-session");
    latch.push(`${JSON.stringify({ type: "init", session_id: "minted-session" })}\n`);

    expect(onSessionId).not.toHaveBeenCalled();
    expect(latch.sessionId).toBe("minted-session");
  });

  it("stops accumulating once the buffer passes its cap", () => {
    const parse = vi.fn(parseFixtureJsonl);
    const onSessionId = vi.fn();
    const latch = createStreamSessionIdLatch({ parse, onSessionId, maxBufferBytes: 64 });

    latch.push("x".repeat(100));
    const callsAfterOverflow = parse.mock.calls.length;
    latch.push(`${JSON.stringify({ type: "init", session_id: "too-late" })}\n`);

    expect(parse.mock.calls.length).toBe(callsAfterOverflow);
    expect(onSessionId).not.toHaveBeenCalled();
  });

  it("survives a parser that throws on a partial buffer", () => {
    const onSessionId = vi.fn();
    const latch = createStreamSessionIdLatch({
      parse: (buffer) => {
        if (!buffer.endsWith("\n")) throw new Error("partial");
        return parseFixtureJsonl(buffer);
      },
      onSessionId,
    });

    expect(() => latch.push("{\"session_id\":\"late\"")).not.toThrow();
    latch.push("}\n");
    expect(onSessionId).toHaveBeenCalledExactlyOnceWith("late");
  });
});

describe("buildClaudeTranscriptProbePath", () => {
  // Verified against a live ~/.claude/projects listing; see the helper's doc
  // comment. The doubled hyphen in "claude-501--Users" is the tell that an
  // existing hyphen passes through while the following slash becomes its own.
  it("mirrors the CLI's project-directory encoding", () => {
    expect(
      buildClaudeTranscriptProbePath({
        claudeConfigDir: "/home/agent/.claude",
        recordedCwd: "/Users/ngoodman/dev/pw/backlit-os",
        sessionId: "5c1f0f1e-0000-4000-8000-000000000001",
      }),
    ).toBe(
      path.join(
        "/home/agent/.claude",
        "projects",
        "-Users-ngoodman-dev-pw-backlit-os",
        "5c1f0f1e-0000-4000-8000-000000000001.jsonl",
      ),
    );

    expect(
      buildClaudeTranscriptProbePath({
        claudeConfigDir: "/home/agent/.claude",
        recordedCwd: "/private/tmp/claude-501/-Users-ngoodman-dev-pw-backlit-os",
        sessionId: "abc",
      }),
    ).toContain("-private-tmp-claude-501--Users-ngoodman-dev-pw-backlit-os");
  });

  // The recorded cwd, not the current one: a session minted in worktree A and
  // resumed from worktree B has its transcript under A.
  it("derives the slug from the recorded cwd, not the caller's cwd", () => {
    const probe = buildClaudeTranscriptProbePath({
      claudeConfigDir: "/cfg",
      recordedCwd: "/work/tree-a",
      sessionId: "s1",
    });
    expect(probe).toContain("-work-tree-a");
    expect(probe).not.toContain("tree-b");
  });
});
