import path from "node:path";

/**
 * The wire contract for provisional session checkpointing, plus the pure
 * helpers the three local CLI adapters share.
 *
 * Why this file holds only literals and pure functions: it is imported by
 * adapter `execute.ts` modules that run inside the child-spawn hot path, and by
 * the host sink that persists the events. Neither side may pull a host module
 * in through this seam, so there are deliberately no `node:fs`, no server, and
 * no adapter imports here — `node:path` is the only dependency, and it is used
 * for string composition, never for I/O.
 *
 * The two event-type literals are duplicated by design on the host side rather
 * than imported across the package boundary. They are a wire contract between
 * two independently-deployed halves; a shared import would make a rename look
 * safe when it is not.
 *
 * On re-parsing the whole accumulated buffer (see `createStreamSessionIdLatch`):
 * the three harness parsers — `parseClaudeStreamJson`, `parseCodexJsonl`,
 * `parseOpenCodeJsonl` — are pure line loops that `split(/\r?\n/)`, skip a line
 * that does not parse as JSON, and return whatever they found. They are already
 * called on a partial, mid-run buffer today: claude-local's
 * `execute.ts` passes `parseClaudeStreamJson(stdout)` as the
 * `terminalResultCleanup.hasTerminalResult` predicate, which the process runner
 * invokes on every stdout chunk while the child is still alive. Re-parsing the
 * accumulated buffer is therefore an established, unmodified use of those
 * parsers, and it is what lets all three be reused here without teaching them
 * about chunk boundaries.
 */

/**
 * A provisional session checkpoint: "this attempt is running under this session
 * id, and here are the session params to persist if the run dies right now".
 * Provisional is the operative word — the adapter's final
 * `AdapterExecutionResult` is still authoritative and may clear it.
 */
export const SESSION_CHECKPOINT_EVENT_TYPE = "session.checkpoint";

/**
 * The recovery decision for one run: whether it started fresh because nothing
 * was ever recorded, resumed a recorded session, or started fresh because a
 * recorded session could not be used. The three outcomes must stay separately
 * countable — a lost conversation has to be distinguishable from a first run.
 */
export const SESSION_RECOVERY_EVENT_TYPE = "session.recovery";

export interface SessionCheckpointPayload {
  /** 1-based attempt number within a single `execute()` call. */
  attempt: number;
  sessionId: string;
  sessionParams: Record<string, unknown>;
  /**
   * Where this id came from, which is what makes the three recovery outcomes
   * classifiable from the checkpoint alone.
   *
   * `"minted"` means caller-supplied: Paperclip handed the id to the harness
   * before the harness had said anything — Claude's `--session-id` on a fresh
   * attempt, or the `--resume` argument on a resumed one. An id checkpointed
   * that way whose transcript never appeared is outcome 1, *nothing was ever
   * created*, not outcome 3.
   *
   * `"stream"` means harness-confirmed: the harness named the session in its
   * own output, so the session demonstrably existed and a later absence is
   * outcome 3, *a session existed and is gone*.
   */
  source: "minted" | "stream";
}

export interface SessionRecoveryPayload {
  outcome: "fresh_none" | "resumed" | "fresh_missing";
  /** The recorded session id this outcome is about, or null when none existed. */
  sessionId: string | null;
  reason: string;
}

export interface StreamSessionIdLatch {
  /** Feed one raw stdout chunk. Cheap and safe to call after the latch settles. */
  push(chunk: string): void;
  /**
   * Settle the latch without firing the callback. Used when the session id is
   * already known before the child produces output (Claude mints it), so a
   * later stream observation of the same id does not emit a second checkpoint.
   */
  settle(sessionId: string): void;
  /** The settled session id, or null while the latch is still open. */
  readonly sessionId: string | null;
}

/**
 * The default accumulation cap. A harness that has not named its session in the
 * first megabyte of stdout is not going to; past that point the buffer is pure
 * cost (it is re-parsed per chunk) and the id is still recoverable from the
 * complete stdout after the child exits, which is the pre-existing behaviour.
 */
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Accumulate raw stdout chunks and re-parse the whole buffer with the supplied
 * adapter parser on each one, firing `onSessionId` exactly once on the first
 * non-null session id.
 *
 * The latch settles on first fire and then drops its buffer, so the O(n^2)
 * re-parse cost is bounded by however much output precedes the harness's first
 * session-carrying event — one event for all three harnesses in practice.
 */
export function createStreamSessionIdLatch(input: {
  parse: (buffer: string) => { sessionId: string | null };
  onSessionId: (sessionId: string) => void;
  maxBufferBytes?: number;
}): StreamSessionIdLatch {
  const maxBufferBytes = input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  let buffer = "";
  let settledSessionId: string | null = null;
  let closed = false;

  return {
    get sessionId() {
      return settledSessionId;
    },
    settle(sessionId: string) {
      if (closed) return;
      closed = true;
      buffer = "";
      settledSessionId = sessionId;
    },
    push(chunk: string) {
      if (closed) return;
      buffer += chunk;
      // Give up rather than keep paying to re-parse output that plainly does
      // not carry an id. Finalization still recovers it from the full stdout.
      if (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
        closed = true;
        buffer = "";
        return;
      }
      let parsed: { sessionId: string | null };
      try {
        parsed = input.parse(buffer);
      } catch {
        // A parser throwing on a partial buffer must never take the run down;
        // the next chunk re-parses a longer buffer anyway.
        return;
      }
      const sessionId = parsed.sessionId;
      if (!sessionId) return;
      closed = true;
      buffer = "";
      settledSessionId = sessionId;
      input.onSessionId(sessionId);
    },
  };
}

/**
 * The on-disk path of a Claude CLI session transcript.
 *
 * The CLI keys its JSONL transcripts by an encoding of the project directory:
 * every character outside `[a-zA-Z0-9-]` becomes `-`, and existing hyphens pass
 * through unchanged. Verified against a live `~/.claude/projects` listing — for
 * example the directory `/home/dev/project` is stored as
 * `-home-dev-project`, and a path under `/private/tmp/runner-7/`
 * keeps the hyphen in `runner-7` while turning the following `/` into its own
 * `-`, producing the doubled `501--Users` seen on disk.
 *
 * `recordedCwd` must be the cwd that was recorded alongside the session, not the
 * cwd of the current execution. A session minted in worktree A and resumed from
 * worktree B has its transcript under A; probing B finds nothing and would
 * wrongly report the session as lost, and — on the poisoned-transcript path —
 * would delete nothing while reporting success.
 *
 * It must also already be symlink-resolved. What the CLI encodes is the child's
 * own `process.cwd()`, which the OS resolved on the way in — a macOS workspace
 * under `/var/folders/...` is filed as `-private-var-folders-...`. Resolving is
 * the caller's job because it is I/O and this file stays pure.
 *
 * Only Claude gets a probe here. Codex stores rollouts under
 * `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<thread_id>.jsonl`,
 * which is not derivable from the thread id alone (the CLI resolves it through
 * its own state db), and OpenCode keys `storage/session/` by an opaque project
 * hash. Neither layout can be probed without inventing a path scheme, so
 * neither adapter gets one; both already detect an unusable session from the
 * harness's own unknown-session error and retry fresh.
 */
export function buildClaudeTranscriptProbePath(input: {
  claudeConfigDir: string;
  recordedCwd: string;
  sessionId: string;
}): string {
  const encodedCwd = input.recordedCwd.replace(/[^a-zA-Z0-9-]/g, "-");
  return path.join(input.claudeConfigDir, "projects", encodedCwd, `${input.sessionId}.jsonl`);
}
