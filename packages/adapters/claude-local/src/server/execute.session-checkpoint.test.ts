import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  probeFailure,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(),
  // Lets a test make one fs call answer an errno instead of the truth, keyed
  // on a path suffix so nothing else in the adapter's filesystem work is
  // disturbed. PAPERCLIP_HOME is a gcsfuse mount in production, which is where
  // a non-ENOENT errno actually comes from.
  probeFailure: {
    stat: null as { suffix: string; code: string } | null,
    realpath: null as { suffix: string; code: string } | null,
  },
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const failFor = (kind: "stat" | "realpath", target: unknown) => {
    const failure = probeFailure[kind];
    if (!failure || typeof target !== "string" || !target.endsWith(failure.suffix)) return null;
    return Object.assign(new Error(`${failure.code}: simulated ${kind} failure`), { code: failure.code });
  };
  const stat = (async (target: unknown, ...rest: unknown[]) => {
    const failure = failFor("stat", target);
    if (failure) throw failure;
    return (actual.stat as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.stat;
  const realpath = (async (target: unknown, ...rest: unknown[]) => {
    const failure = failFor("realpath", target);
    if (failure) throw failure;
    return (actual.realpath as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.realpath;
  // execute.ts imports the default export (`import fs from "node:fs/promises"`),
  // so the default has to be patched alongside the named exports.
  return { ...actual, stat, realpath, default: { ...actual, stat, realpath } };
});

// The ACP lane is resolved before any of this code runs; pin the CLI lane so
// the test exercises the spawn path rather than the ACP executor.
vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  formatClaudeAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORDED_SESSION_ID = "11111111-2222-4333-8444-555555555555";

type ProcOpts = {
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
};

function streamLines(sessionId: string, extra: Record<string, unknown> = {}) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: "done",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      ...extra,
    }),
  ].join("\n");
}

/**
 * Spawn, then deliver the stream in two chunks split mid-JSON-object. The split
 * is the point: it proves the latch re-parses the accumulated buffer rather
 * than assuming a chunk is a whole line.
 */
function mockRun(stdout: string, exitCode = 0) {
  return async (
    _runId: string,
    _target: unknown,
    _command: string,
    _args: string[],
    opts: ProcOpts,
  ) => {
    await opts.onSpawn?.({ pid: 4242, processGroupId: 4242, startedAt: new Date().toISOString() });
    const split = Math.floor(stdout.length / 3);
    await opts.onLog("stdout", stdout.slice(0, split));
    await opts.onLog("stdout", stdout.slice(split));
    return {
      exitCode,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    };
  };
}

/**
 * Spawn, stream whatever the harness managed to emit, then report the run as
 * killed by the timeout. `stdout` is what the process runner captured, which
 * on a real timeout is whatever had arrived before the kill.
 */
function mockTimedOutRun(stdout: string) {
  return async (
    _runId: string,
    _target: unknown,
    _command: string,
    _args: string[],
    opts: ProcOpts,
  ) => {
    await opts.onSpawn?.({ pid: 4242, processGroupId: 4242, startedAt: new Date().toISOString() });
    if (stdout) await opts.onLog("stdout", stdout);
    return {
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout,
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    };
  };
}

function checkpoints(events: AdapterRuntimeEvent[]) {
  return events.filter((event) => event.eventType === "session.checkpoint");
}

function recoveries(events: AdapterRuntimeEvent[]) {
  return events.filter((event) => event.eventType === "session.recovery");
}

describe("claude_local session checkpointing", () => {
  let root = "";
  let workspace = "";
  let workspaceLink = "";
  let claudeConfigDir = "";
  let events: AdapterRuntimeEvent[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    probeFailure.stat = null;
    probeFailure.realpath = null;
    // realpath the root: on macOS os.tmpdir() is the symlink /var/folders/...
    // and the CLI files transcripts under the resolved /private/var/... slug.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-checkpoint-")));
    workspace = path.join(root, "workspace");
    workspaceLink = path.join(root, "workspace-link");
    claudeConfigDir = path.join(root, "claude-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.symlink(workspace, workspaceLink);
    events = [];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Writes the transcript where the CLI would: under the slug of the RESOLVED
  // cwd, because the child's process.cwd() has already followed the symlink.
  async function writeTranscript(recordedCwd: string, sessionId: string) {
    const encoded = (await fs.realpath(recordedCwd)).replace(/[^a-zA-Z0-9-]/g, "-");
    const dir = path.join(claudeConfigDir, "projects", encoded);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), "{}\n", "utf8");
  }

  function buildCtx(runtimeOverrides: Record<string, unknown> = {}) {
    return {
      runId: "run-checkpoint",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
        ...runtimeOverrides,
      },
      config: {
        engine: "cli",
        cwd: workspace,
        env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
      context: {},
      onLog: vi.fn(async () => {}),
      onEvent: vi.fn(async (event: AdapterRuntimeEvent) => {
        events.push(event);
      }),
    };
  }

  // Outcome 1: nothing was ever recorded. The run still checkpoints, because
  // Claude is the harness where the caller can name the session up front.
  it("mints a session id, passes it as --session-id, and checkpoints it at spawn on a first run", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("ignored-by-latch")));

    const result = await execute(buildCtx() as never);

    expect(result.exitCode).toBe(0);
    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    const mintedIndex = args.indexOf("--session-id");
    expect(mintedIndex).toBeGreaterThanOrEqual(0);
    const minted = args[mintedIndex + 1] ?? "";
    expect(minted).toMatch(UUID_RE);
    expect(args).not.toContain("--resume");

    const recorded = checkpoints(events);
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0]?.payload).toMatchObject({
      attempt: 1,
      sessionId: minted,
      sessionParams: expect.objectContaining({ sessionId: minted, cwd: workspace }),
      // Caller-supplied, not harness-confirmed: this id has no transcript yet,
      // so a later probe that misses is outcome 1, never a lost conversation.
      source: "minted",
    });

    expect(recoveries(events)).toHaveLength(1);
    expect(recoveries(events)[0]?.payload).toMatchObject({
      outcome: "fresh_none",
      sessionId: null,
    });
  });

  // The stream latch is a divergence check on Claude: the pre-spawn checkpoint
  // already carries the minted id, so an echo of that same id must not produce
  // a duplicate, but a CLI that names a different session must be re-recorded.
  it("re-checkpoints only when the stream names a session other than the minted one", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("cli-chose-another")));

    await execute(buildCtx() as never);

    const recorded = checkpoints(events);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.payload).toMatchObject({ source: "minted" });
    expect(recorded[1]?.payload).toMatchObject({
      attempt: 1,
      sessionId: "cli-chose-another",
      // Harness-confirmed this time: the CLI named it, so it exists.
      source: "stream",
    });
  });

  it("emits exactly one checkpoint when the CLI echoes back the minted id", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      args: string[],
      opts: ProcOpts,
    ) => {
      const minted = args[args.indexOf("--session-id") + 1] ?? "";
      return mockRun(streamLines(minted))(_runId, _target, _command, args, opts);
    });

    await execute(buildCtx() as never);

    expect(checkpoints(events)).toHaveLength(1);
  });

  // Outcome 2: the recorded session's transcript exists, so --resume is passed
  // and the harness accepts it.
  it("resumes a recorded session whose transcript exists and records outcome resumed", async () => {
    await writeTranscript(workspace, RECORDED_SESSION_ID);
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines(RECORDED_SESSION_ID)));

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(RECORDED_SESSION_ID);
    expect(args).not.toContain("--session-id");

    expect(checkpoints(events)[0]?.payload).toMatchObject({
      attempt: 1,
      sessionId: RECORDED_SESSION_ID,
    });
    expect(recoveries(events)).toHaveLength(1);
    expect(recoveries(events)[0]?.payload).toMatchObject({
      outcome: "resumed",
      sessionId: RECORDED_SESSION_ID,
    });
  });

  // The probe must resolve the recorded cwd before encoding it, because that is
  // what the CLI did: it encoded the child's process.cwd(), which the OS had
  // already followed through the symlink. Encoding the raw recorded string
  // would probe a directory that never existed and kill resume for every
  // workspace reached through a link — /tmp and /var on macOS included.
  it("resolves a symlinked recorded cwd before probing for the transcript", async () => {
    await writeTranscript(workspaceLink, RECORDED_SESSION_ID);
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines(RECORDED_SESSION_ID)));

    const ctx = buildCtx({
      sessionId: RECORDED_SESSION_ID,
      sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspaceLink },
    });
    ctx.config.cwd = workspaceLink;
    await execute(ctx as never);

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(RECORDED_SESSION_ID);
    expect(recoveries(events)[0]?.payload).toMatchObject({ outcome: "resumed" });
  });

  // Outcome 3, detected before the spawn: the transcript probe fails, so the
  // run does not burn an attempt on a --resume that cannot work.
  it("starts fresh without --resume when the recorded transcript is missing", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("fresh")));

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).not.toContain("--resume");
    expect(args).toContain("--session-id");

    const recovery = recoveries(events);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.payload).toMatchObject({
      outcome: "fresh_missing",
      sessionId: RECORDED_SESSION_ID,
    });
    expect(String(recovery[0]?.payload?.reason)).toContain(`${RECORDED_SESSION_ID}.jsonl`);
  });

  // The checkpoint is fire-and-forget, so a rejecting sink must not reach the
  // run as an unhandled rejection — that is what the `.catch` on
  // emitSessionCheckpoint is for. The recovery event is deliberately NOT
  // guarded this way: it is awaited like onMeta and onLog, so a sink that
  // rejects there does fail the run, which is the existing idiom.
  it("survives an onEvent sink that rejects the checkpoint", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("whatever")));
    const ctx = buildCtx();
    ctx.onEvent = vi.fn(async (event: AdapterRuntimeEvent) => {
      if (event.eventType === "session.checkpoint") throw new Error("sink is down");
      events.push(event);
    });

    await expect(execute(ctx as never)).resolves.toMatchObject({ exitCode: 0 });
    expect(recoveries(events)).toHaveLength(1);
  });

  // The per-attempt scoping trap. A latch (or a checkpoint) that survived the
  // attempt boundary would report the dead session X after the fresh session Y
  // was already minted, and the next run would resume the wrong one.
  it("checkpoints each attempt under its own session id when the resume is rejected", async () => {
    await writeTranscript(workspace, RECORDED_SESSION_ID);
    runAdapterExecutionTargetProcess
      .mockImplementationOnce(
        mockRun(
          [
            JSON.stringify({
              type: "result",
              subtype: "error",
              is_error: true,
              session_id: RECORDED_SESSION_ID,
              result: `No conversation found with session id ${RECORDED_SESSION_ID}`,
            }),
          ].join("\n"),
          1,
        ),
      )
      .mockImplementationOnce(mockRun(streamLines("fresh-after-retry")));

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const retryArgs = runAdapterExecutionTargetProcess.mock.calls[1]?.[3] as string[];
    const retryMinted = retryArgs[retryArgs.indexOf("--session-id") + 1] ?? "";
    expect(retryMinted).toMatch(UUID_RE);
    expect(retryMinted).not.toBe(RECORDED_SESSION_ID);

    const byAttempt = checkpoints(events).map((event) => ({
      attempt: event.payload?.attempt,
      sessionId: event.payload?.sessionId,
    }));
    expect(byAttempt).toContainEqual({ attempt: 1, sessionId: RECORDED_SESSION_ID });
    expect(byAttempt).toContainEqual({ attempt: 2, sessionId: retryMinted });
    // Nothing from attempt 1 may be checkpointed after attempt 2 started.
    const lastAttemptOne = byAttempt.findLastIndex((entry) => entry.attempt === 1);
    const firstAttemptTwo = byAttempt.findIndex((entry) => entry.attempt === 2);
    expect(lastAttemptOne).toBeLessThan(firstAttemptTwo);

    const recovery = recoveries(events);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.payload).toMatchObject({
      outcome: "fresh_missing",
      sessionId: RECORDED_SESSION_ID,
    });
  });

  // Spec: "Every harness's session identifier SHALL be durably checkpointed as
  // soon as it is knowable" — Claude's checkpoint fires at spawn, before the
  // child has produced a single byte. And per the shared latch contract: a
  // divergent session id named mid-stream must not be reported until the
  // JSONL line naming it is actually complete, even though the chunk boundary
  // splits it mid-token — a chunk is bytes, not a line (server-utils.ts).
  it("checkpoints before any stdout, and only re-checkpoints a divergent session once its split line completes", async () => {
    const initLine = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "cli-chose-another",
      model: "claude-sonnet",
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "cli-chose-another",
      result: "done",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    });
    const full = `${initLine}\n${resultLine}`;
    // Split inside the session_id value's characters, not at a JSON delimiter.
    const splitPoint = initLine.indexOf("chose-another") + 4;

    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      opts: ProcOpts,
    ) => {
      await opts.onSpawn?.({ pid: 4242, processGroupId: 4242, startedAt: new Date().toISOString() });
      // Checkpoint fires from onSpawn, before the child has produced output.
      expect(checkpoints(events)).toHaveLength(1);

      await opts.onLog("stdout", full.slice(0, splitPoint));
      // The line naming "cli-chose-another" is not complete yet: no divergence
      // checkpoint must fire on a partial token.
      expect(checkpoints(events)).toHaveLength(1);

      await opts.onLog("stdout", full.slice(splitPoint));
      // Now that the line is whole, the divergence checkpoint fires exactly once.
      expect(checkpoints(events)).toHaveLength(2);

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: full,
        stderr: "",
        pid: 4242,
        startedAt: new Date().toISOString(),
      };
    });

    await execute(buildCtx() as never);

    const recorded = checkpoints(events);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]?.payload).toMatchObject({ attempt: 1, sessionId: "cli-chose-another" });
  });

  // Regression pin: the transcript-existence gate must derive its probe path
  // from the RECORDED cwd (what the session was saved under), never the
  // CURRENT execution cwd. A decoy transcript sitting at the current cwd's
  // slug must not be mistaken for the recorded session's transcript, and the
  // recovery reason must name the recorded path even though a file happens to
  // exist at the current one.
  it("names the recorded path in fresh_missing even when a decoy transcript exists at the current cwd", async () => {
    const currentWorkspace = path.join(root, "current-workspace");
    await fs.mkdir(currentWorkspace, { recursive: true });
    // Decoy: sits at the CURRENT cwd's slug. If the gate ever regresses to
    // probing the current cwd instead of the recorded one, it would find this
    // file and wrongly treat the session as resumable.
    await writeTranscript(currentWorkspace, RECORDED_SESSION_ID);
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("fresh-again")));

    const ctx = buildCtx({
      sessionId: RECORDED_SESSION_ID,
      sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace }, // recorded cwd: no transcript here
    });
    ctx.config.cwd = currentWorkspace; // this run's cwd differs from the recorded one

    await execute(ctx as never);

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).not.toContain("--resume");

    const recovery = recoveries(events);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.payload).toMatchObject({
      outcome: "fresh_missing",
      sessionId: RECORDED_SESSION_ID,
    });
    const reason = String(recovery[0]?.payload?.reason);
    const recordedSlug = workspace.replace(/[^a-zA-Z0-9-]/g, "-");
    const decoySlug = currentWorkspace.replace(/[^a-zA-Z0-9-]/g, "-");
    expect(reason).toContain(recordedSlug);
    expect(reason).toContain(`${RECORDED_SESSION_ID}.jsonl`);
    expect(reason).not.toContain(decoySlug);
  });

  // The STREAM checkpoint is fire-and-forget, not awaited. A sink that never
  // settles must not stall the child's stdout consumption or the run itself —
  // awaiting it would apply backpressure through server-utils.ts's onLog
  // serialization and hang the process. The `source: "minted"` checkpoint at
  // spawn deliberately does NOT share that property: it is awaited so that
  // "this run has a pid" implies "this run has a checkpoint", which puts it on
  // the same footing as onSpawn and onMeta, both of which also hang on a host
  // that never answers.
  it("does not stall on a stream checkpoint sink that never resolves", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("whatever")));
    const ctx = buildCtx();
    ctx.onEvent = vi.fn((event: AdapterRuntimeEvent) => {
      if (event.eventType === "session.checkpoint" && event.payload?.source === "stream") {
        return new Promise<void>(() => {});
      }
      events.push(event);
      return Promise.resolve();
    });

    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    // The divergent stream id is what hung, so the run must have got past a
    // checkpoint that never settled — not simply never reached one.
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "session.checkpoint",
        payload: expect.objectContaining({ source: "stream", sessionId: "whatever" }),
      }),
    );
  });

  // No latch (or buffer) may survive across the attempt boundary. Attempt 1's
  // stream is deliberately left with a dangling, never-completed partial
  // fragment before it errors out; if a latch or buffer were reused instead of
  // freshly constructed per attempt, attempt 2's first bytes would complete
  // that leftover fragment into a bogus session id.
  it("does not let attempt 1's incomplete trailing fragment leak into attempt 2's parse", async () => {
    await writeTranscript(workspace, RECORDED_SESSION_ID);
    const attempt1ErrorLine = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      session_id: RECORDED_SESSION_ID,
      result: `No conversation found with session id ${RECORDED_SESSION_ID}`,
    });
    // Dangling, unterminated fragment appended to what attempt 1 streams to the
    // latch. It never closes, so a correctly-scoped (fresh per attempt) latch
    // must never fire from it.
    const danglingFragment = '\n{"type":"system","session_id":"leaked-partial';

    runAdapterExecutionTargetProcess
      .mockImplementationOnce(async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        opts: ProcOpts,
      ) => {
        await opts.onSpawn?.({ pid: 1, processGroupId: 1, startedAt: new Date().toISOString() });
        await opts.onLog("stdout", attempt1ErrorLine + danglingFragment);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          // The final parsed result must stay clean; the dangling fragment
          // only ever reached the latch via onLog, mirroring how a real CLI's
          // last flushed bytes can outrun what the process runner returns.
          stdout: attempt1ErrorLine,
          stderr: "",
          pid: 1,
          startedAt: new Date().toISOString(),
        };
      })
      // Attempt 2's first delivered bytes would complete attempt 1's dangling
      // fragment into `..."leaked-partialXX"}` if the buffer leaked. Scoped
      // correctly, attempt 2 sees only its own bytes.
      .mockImplementationOnce(mockRun(streamLines("fresh-after-retry")));

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const allSessionIds = checkpoints(events).map((event) => event.payload?.sessionId);
    expect(allSessionIds.some((id) => typeof id === "string" && id.includes("leaked"))).toBe(false);
    expect(allSessionIds).toContain(RECORDED_SESSION_ID);
    expect(allSessionIds).toContain("fresh-after-retry");
  });

  // The headline regression. A timed-out result that names neither sessionId
  // nor sessionParams is not neutral: resolveNextSessionState falls back to the
  // pre-dispatch snapshot — null on a first run — and writes it over the
  // checkpoint this run just persisted. The timeout is the common case the
  // whole mechanism exists for, so a checkpoint that a timeout deletes is a
  // checkpoint that never survives.
  it("carries the minted session out of a timeout instead of deleting its own checkpoint", async () => {
    // Killed before the harness emitted a single byte: nothing but the minted
    // id is knowable, which is exactly why it is minted.
    runAdapterExecutionTargetProcess.mockImplementation(mockTimedOutRun(""));

    const result = await execute(buildCtx() as never);

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    const minted = args[args.indexOf("--session-id") + 1] ?? "";
    expect(minted).toMatch(UUID_RE);

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe(minted);
    expect(result.sessionParams).toMatchObject({ sessionId: minted, cwd: workspace });
    expect(result.sessionDisplayId).toBe(minted);
    expect(result.clearSession).toBe(false);
  });

  // A timeout that happened after the CLI named a session must carry the id the
  // CLI named, not the one it was handed.
  it("prefers the stream-confirmed session over the minted one when a timeout follows divergence", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(
      mockTimedOutRun(
        JSON.stringify({ type: "system", subtype: "init", session_id: "cli-chose-another", model: "claude-sonnet" }),
      ),
    );

    const result = await execute(buildCtx() as never);

    expect(result.sessionId).toBe("cli-chose-another");
    expect(result.sessionParams).toMatchObject({ sessionId: "cli-chose-another" });
    expect(result.clearSession).toBe(false);
  });

  // The retry lane carries clearSessionOnMissingSession, which used to mean a
  // timed-out retry cleared the session outright. Attempt 2 minted a fresh id
  // and spent the whole timeout window under it; that is the id to keep.
  it("keeps attempt 2's minted session when the retry itself times out", async () => {
    await writeTranscript(workspace, RECORDED_SESSION_ID);
    runAdapterExecutionTargetProcess
      .mockImplementationOnce(
        mockRun(
          JSON.stringify({
            type: "result",
            subtype: "error",
            is_error: true,
            session_id: RECORDED_SESSION_ID,
            result: `No conversation found with session id ${RECORDED_SESSION_ID}`,
          }),
          1,
        ),
      )
      .mockImplementationOnce(mockTimedOutRun(""));

    const result = await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const retryArgs = runAdapterExecutionTargetProcess.mock.calls[1]?.[3] as string[];
    const retryMinted = retryArgs[retryArgs.indexOf("--session-id") + 1] ?? "";

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe(retryMinted);
    expect(result.sessionId).not.toBe(RECORDED_SESSION_ID);
    expect(result.clearSession).toBe(false);
  });

  // The same deletion on the unparsed lane: a child that dies on a transient
  // upstream error after real work leaves no result JSON, and naming nothing
  // there lets the pre-dispatch snapshot overwrite the checkpoint.
  it("carries a stream-confirmed session out of a run with no parseable result", async () => {
    const initLine = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "stream-confirmed",
      model: "claude-sonnet",
    });
    // Trailing garbage so the whole stdout is not itself parseable as JSON,
    // which is what puts this run on the unparsed lane.
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(`${initLine}\nOverloaded (529)`, 1));

    const result = await execute(buildCtx() as never);

    expect(result.sessionId).toBe("stream-confirmed");
    expect(result.sessionParams).toMatchObject({ sessionId: "stream-confirmed" });
    expect(result.clearSession).toBe(false);
  });

  // ...but only a STREAM-confirmed id. The minted id has no transcript to show
  // for itself here, and persisting it would make the next run's failed probe
  // report outcome 3 (a session was lost) for what is outcome 1 (none was ever
  // created).
  it("names no session when an unparseable run never had the CLI confirm one", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun("Invalid API key", 1));

    const result = await execute(buildCtx() as never);

    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
  });

  // G1-3. PAPERCLIP_HOME is a gcsfuse mount: a stat there can answer EIO or
  // stall while the transcript is perfectly intact. Reading that as "the file
  // is not there" discards a live conversation and mints a fresh one, so only
  // an errno that actually means absence may decide.
  it("resumes anyway when the transcript probe fails with an errno that is not absence", async () => {
    await writeTranscript(workspace, RECORDED_SESSION_ID);
    probeFailure.stat = { suffix: `${RECORDED_SESSION_ID}.jsonl`, code: "EIO" };
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines(RECORDED_SESSION_ID)));

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(RECORDED_SESSION_ID);
    expect(recoveries(events)[0]?.payload).toMatchObject({ outcome: "resumed" });
  });

  // The same hole one line earlier: a realpath that fails with a non-absence
  // errno leaves the raw recorded string as the slug, and on a box where /var
  // resolves to /private/var that slug is simply wrong — the stat then ENOENTs
  // and the false "missing" verdict arrives by a different door.
  it("resumes anyway when the recorded cwd fails to resolve with an errno that is not absence", async () => {
    await writeTranscript(workspaceLink, RECORDED_SESSION_ID);
    probeFailure.realpath = { suffix: "workspace-link", code: "EIO" };
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines(RECORDED_SESSION_ID)));

    const ctx = buildCtx({
      sessionId: RECORDED_SESSION_ID,
      sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspaceLink },
    });
    ctx.config.cwd = workspaceLink;
    await execute(ctx as never);

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).toContain("--resume");
    expect(recoveries(events)[0]?.payload).toMatchObject({ outcome: "resumed" });
  });

  // The other half of the same rule: ENOENT really does mean absent, and must
  // still discard the session rather than burning an attempt on a --resume
  // that cannot work.
  it("still starts fresh when the probe answers ENOENT", async () => {
    probeFailure.stat = { suffix: `${RECORDED_SESSION_ID}.jsonl`, code: "ENOENT" };
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(streamLines("fresh")));

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).not.toContain("--resume");
    expect(recoveries(events)[0]?.payload).toMatchObject({
      outcome: "fresh_missing",
      sessionId: RECORDED_SESSION_ID,
    });
  });
});
