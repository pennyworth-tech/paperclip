import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
  tempCodexHome: "/tmp/paperclip-codex-session-checkpoint-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
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

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute } from "./execute.js";

const RECORDED_THREAD_ID = "019fc857-96e8-7a22-8598-46411de27b4d";

type ProcOpts = {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
};

function threadStream(threadId: string) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
  ].join("\n");
}

/**
 * Deliver stdout in two chunks split mid-JSON-object. The split is the point:
 * it proves the latch re-parses the accumulated buffer rather than assuming a
 * chunk boundary is a line boundary.
 */
function mockRun(stdout: string, opts: { exitCode?: number; stderr?: string } = {}) {
  return async (
    _runId: string,
    _target: unknown,
    _command: string,
    _args: string[],
    procOpts: ProcOpts,
  ) => {
    const split = Math.floor(stdout.length / 3);
    await procOpts.onLog("stdout", stdout.slice(0, split));
    await procOpts.onLog("stdout", stdout.slice(split));
    return {
      exitCode: opts.exitCode ?? 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: opts.stderr ?? "",
      pid: 321,
      startedAt: new Date().toISOString(),
    };
  };
}

describe("codex_local session checkpointing", () => {
  let workspace = "";
  let events: AdapterRuntimeEvent[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-checkpoint-"));
    events = [];
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildCtx(runtimeOverrides: Record<string, unknown> = {}) {
    return {
      runId: "run-checkpoint",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Coder",
        adapterType: "codex_local",
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
        outputInactivityTimeoutMs: null,
        cwd: workspace,
        env: { OPENAI_API_KEY: "test-key" },
      },
      context: {},
      onLog: vi.fn(async () => {}),
      onEvent: vi.fn(async (event: AdapterRuntimeEvent) => {
        events.push(event);
      }),
    };
  }

  function checkpoints() {
    return events.filter((event) => event.eventType === "session.checkpoint");
  }

  function recoveries() {
    return events.filter((event) => event.eventType === "session.recovery");
  }

  // Codex cannot be handed a thread id, so the earliest the identifier exists is
  // the `thread.started` event in its stream. Checkpointing there — not after
  // the child exits — is the whole point: a first run killed after real work
  // would otherwise lose its server-side association entirely.
  it("checkpoints the thread id from the stream on a first run, before the child exits", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(threadStream("thread-first-run")));

    const result = await execute(buildCtx() as never);

    expect(result.exitCode).toBe(0);
    const recorded = checkpoints();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({
      attempt: 1,
      sessionId: "thread-first-run",
      sessionParams: expect.objectContaining({ sessionId: "thread-first-run", cwd: workspace }),
      // Harness-confirmed: codex named the thread itself, so a later absence is
      // a lost conversation (outcome 3), not a session that never existed.
      source: "stream",
    });

    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0]?.payload).toMatchObject({ outcome: "fresh_none", sessionId: null });
  });

  it("resumes a recorded thread and records outcome resumed", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(threadStream(RECORDED_THREAD_ID)));

    await execute(
      buildCtx({
        sessionId: RECORDED_THREAD_ID,
        sessionParams: { sessionId: RECORDED_THREAD_ID, cwd: workspace },
      }) as never,
    );

    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(args).toContain("resume");
    expect(args).toContain(RECORDED_THREAD_ID);

    expect(checkpoints()[0]?.payload).toMatchObject({ attempt: 1, sessionId: RECORDED_THREAD_ID });
    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0]?.payload).toMatchObject({
      outcome: "resumed",
      sessionId: RECORDED_THREAD_ID,
    });
  });

  // The per-attempt scoping trap. A latch that survived the attempt boundary
  // would still hold the dead thread and checkpoint it over the live one.
  it("checkpoints each attempt under its own thread id when the resume is rejected", async () => {
    runAdapterExecutionTargetProcess
      .mockImplementationOnce(
        mockRun(JSON.stringify({ type: "thread.started", thread_id: RECORDED_THREAD_ID }), {
          exitCode: 1,
          stderr: `Error: thread/resume: thread/resume failed: no rollout found for thread id ${RECORDED_THREAD_ID}`,
        }),
      )
      .mockImplementationOnce(mockRun(threadStream("thread-after-retry")));

    await execute(
      buildCtx({
        sessionId: RECORDED_THREAD_ID,
        sessionParams: { sessionId: RECORDED_THREAD_ID, cwd: workspace },
      }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const byAttempt = checkpoints().map((event) => ({
      attempt: event.payload?.attempt,
      sessionId: event.payload?.sessionId,
    }));
    expect(byAttempt).toEqual([
      { attempt: 1, sessionId: RECORDED_THREAD_ID },
      { attempt: 2, sessionId: "thread-after-retry" },
    ]);

    const recovery = recoveries();
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.payload).toMatchObject({
      outcome: "fresh_missing",
      sessionId: RECORDED_THREAD_ID,
    });
  });

  // Spec: codex only has a stream to learn its identifier from, so the
  // checkpoint must fire the moment the `thread.started` LINE is complete —
  // never before, and never from a chunk boundary landing mid-token. A chunk
  // is bytes, not a line (server-utils.ts:3483-3497).
  it("fires the checkpoint only once the split thread.started line completes", async () => {
    const startedLine = JSON.stringify({ type: "thread.started", thread_id: "thread-split-mid-token" });
    const full = `${startedLine}\n${threadStream("thread-split-mid-token").split("\n").slice(1).join("\n")}`;
    // Split inside the thread_id value's characters, not at a JSON delimiter.
    const splitPoint = startedLine.indexOf("thread-split-mid-token") + 6;

    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      procOpts: ProcOpts,
    ) => {
      expect(checkpoints()).toHaveLength(0);
      await procOpts.onLog("stdout", full.slice(0, splitPoint));
      // The line naming the thread id is not complete yet.
      expect(checkpoints()).toHaveLength(0);
      await procOpts.onLog("stdout", full.slice(splitPoint));
      expect(checkpoints()).toHaveLength(1);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: full,
        stderr: "",
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    });

    await execute(buildCtx() as never);

    const recorded = checkpoints();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ attempt: 1, sessionId: "thread-split-mid-token" });
  });

  // Fire-and-forget by design: a checkpoint sink that never resolves must not
  // stall the run.
  it("does not stall on a checkpoint sink that never resolves", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(mockRun(threadStream("thread-no-stall")));
    const ctx = buildCtx();
    ctx.onEvent = vi.fn((event: AdapterRuntimeEvent) => {
      if (event.eventType === "session.checkpoint") return new Promise<void>(() => {});
      events.push(event);
      return Promise.resolve();
    });

    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
  });

  // No buffer may survive across the attempt boundary. Attempt 1 is left with
  // a dangling, never-completed fragment before the resume is rejected; a
  // latch reused across attempts would let attempt 2's first bytes complete it
  // into a bogus thread id.
  it("does not let attempt 1's incomplete trailing fragment leak into attempt 2's parse", async () => {
    const danglingFragment = '\n{"type":"thread.started","thread_id":"leaked-partial';

    runAdapterExecutionTargetProcess
      .mockImplementationOnce(async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        procOpts: ProcOpts,
      ) => {
        const errorLine = `Error: thread/resume: thread/resume failed: no rollout found for thread id ${RECORDED_THREAD_ID}`;
        await procOpts.onLog("stdout", danglingFragment);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: errorLine,
          pid: 321,
          startedAt: new Date().toISOString(),
        };
      })
      .mockImplementationOnce(mockRun(threadStream("thread-after-retry")));

    await execute(
      buildCtx({
        sessionId: RECORDED_THREAD_ID,
        sessionParams: { sessionId: RECORDED_THREAD_ID, cwd: workspace },
      }) as never,
    );

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const allSessionIds = checkpoints().map((event) => event.payload?.sessionId);
    expect(allSessionIds.some((id) => typeof id === "string" && id.includes("leaked"))).toBe(false);
    expect(allSessionIds).toContain("thread-after-retry");
  });

  // The captured `stdout` is only the last MAX_CAPTURE_BYTES of the stream
  // (appendWithCap in server-utils.ts), so on any run long enough to matter the
  // `thread.started` line has scrolled out of it and parsing the capture finds
  // no thread id — on success as much as on failure. The latch read it from the
  // first chunk, and finalization has to ask the latch.
  it("resolves the thread id from the latch when it has scrolled out of the captured stdout", async () => {
    const full = threadStream("thread-scrolled-off");
    // What the runner returns keeps only the tail, exactly as the cap leaves it.
    const capturedTail = full.split("\n").slice(1).join("\n");

    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      procOpts: ProcOpts,
    ) => {
      await procOpts.onLog("stdout", full);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: capturedTail,
        stderr: "",
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    });

    const result = await execute(buildCtx() as never);

    expect(result.sessionId).toBe("thread-scrolled-off");
    expect(result.sessionParams).toMatchObject({ sessionId: "thread-scrolled-off", cwd: workspace });
    expect(result.sessionDisplayId).toBe("thread-scrolled-off");
  });

  // The headline regression. A timed-out result that names neither sessionId
  // nor sessionParams is not neutral: resolveNextSessionState falls back to the
  // pre-dispatch snapshot — null on a first run — and writes it over the
  // checkpoint this run just persisted. Timeout is the common case the whole
  // mechanism exists for.
  it("carries the streamed thread out of a timeout instead of deleting its own checkpoint", async () => {
    const startedLine = JSON.stringify({ type: "thread.started", thread_id: "thread-timed-out" });

    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      procOpts: ProcOpts,
    ) => {
      await procOpts.onLog("stdout", startedLine);
      return {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        stdout: startedLine,
        stderr: "",
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    });

    const result = await execute(buildCtx() as never);

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe("thread-timed-out");
    expect(result.sessionParams).toMatchObject({ sessionId: "thread-timed-out", cwd: workspace });
    expect(result.clearSession).toBe(false);
  });

  // The inactivity monitor kills a codex that has gone quiet. That is a run
  // which may already have named its thread and written turns to disk, so the
  // branch must keep the id for exactly the reason the timeout branch does —
  // and on the retry lane it matters more, because clearSessionOnMissingSession
  // is true there and a bare `clearSession: true` wins over the host's rescue.
  it("carries the streamed thread out of an inactivity kill instead of clearing it", async () => {
    const startedLine = JSON.stringify({ type: "thread.started", thread_id: "thread-went-quiet" });

    runAdapterExecutionTargetProcess.mockImplementation(async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      procOpts: ProcOpts,
    ) => {
      await procOpts.onLog("stdout", startedLine);
      // Outlive the configured inactivity window with no further output: that
      // silence is what the monitor is watching for.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        stdout: startedLine,
        stderr: "",
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    });

    const ctx = buildCtx();
    ctx.config.outputInactivityTimeoutMs = 20;
    const result = await execute(ctx as never);

    expect(result.errorCode).toBe("codex_output_inactivity_monitor");
    expect(result.sessionId).toBe("thread-went-quiet");
    expect(result.sessionParams).toMatchObject({ sessionId: "thread-went-quiet" });
    expect(result.clearSession).toBe(false);
  });

  // Codex cannot be handed a thread id, so a run killed before it named one has
  // nothing to keep. The result must stay silent about the session rather than
  // inventing one, which leaves the pre-dispatch params in place.
  it("names no session when a timeout arrives before the harness named a thread", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => ({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute(buildCtx() as never);

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
  });
});
