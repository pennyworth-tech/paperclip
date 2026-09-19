import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);
const RECORDED_SESSION_ID = "ses_7f3a91c2";

type ProcOpts = {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
};

/**
 * OpenCode has no named session-start event: the session id rides on whichever
 * event carries `sessionID` first. The fixture therefore leads with an ordinary
 * text event, which is exactly the shape parseOpenCodeJsonl reads.
 */
function sessionStream(sessionId: string) {
  return [
    JSON.stringify({ type: "text", sessionID: sessionId, part: { text: "working" } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: sessionId,
      part: { tokens: { input: 1, output: 1, cache: { read: 0 } }, cost: 0 },
    }),
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
      pid: 555,
      startedAt: new Date().toISOString(),
    };
  };
}

describe("opencode_local session checkpointing", () => {
  let root = "";
  let workspace = "";
  let commandPath = "";
  let events: AdapterRuntimeEvent[] = [];
  let previousHome: string | undefined;

  beforeEach(async () => {
    runProcessMock.mockReset();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-checkpoint-"));
    workspace = path.join(root, "workspace");
    commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    previousHome = process.env.HOME;
    process.env.HOME = path.join(root, "home");
    events = [];
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  function buildCtx(runtimeOverrides: Record<string, unknown> = {}) {
    return {
      runId: "run-checkpoint",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Coder",
        adapterType: "opencode_local",
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
        command: commandPath,
        cwd: workspace,
        model: "openai/gpt-5",
        env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        promptTemplate: "Follow the paperclip heartbeat.",
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

  // The earliest the identifier exists is the first stdout event that carries
  // it. Checkpointing there — not after the child exits — is what keeps a first
  // run's hours of real conversation associated with the task when the process
  // is killed mid-run.
  it("checkpoints the session id from the stream on a first run, before the child exits", async () => {
    runProcessMock.mockImplementation(mockRun(sessionStream("ses_first_run")) as never);

    const result = await execute(buildCtx() as never);

    expect(result.exitCode).toBe(0);
    const recorded = checkpoints();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({
      attempt: 1,
      sessionId: "ses_first_run",
      sessionParams: expect.objectContaining({ sessionId: "ses_first_run", cwd: workspace }),
      // Harness-confirmed: OpenCode named the session itself, so a later
      // absence is a lost conversation (outcome 3), not one that never existed.
      source: "stream",
    });

    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0]?.payload).toMatchObject({ outcome: "fresh_none", sessionId: null });
  });

  it("resumes a recorded session and records outcome resumed", async () => {
    runProcessMock.mockImplementation(mockRun(sessionStream(RECORDED_SESSION_ID)) as never);

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    const args = runProcessMock.mock.calls[0]?.[3] as string[];
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe(RECORDED_SESSION_ID);

    expect(checkpoints()[0]?.payload).toMatchObject({ attempt: 1, sessionId: RECORDED_SESSION_ID });
    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0]?.payload).toMatchObject({
      outcome: "resumed",
      sessionId: RECORDED_SESSION_ID,
    });
  });

  // The per-attempt scoping trap. A latch that survived the attempt boundary
  // would still hold the dead session and checkpoint it over the live one.
  it("checkpoints each attempt under its own session id when the resume is rejected", async () => {
    runProcessMock
      .mockImplementationOnce(
        mockRun("", {
          exitCode: 1,
          stderr: `Error: unknown session ${RECORDED_SESSION_ID}`,
        }) as never,
      )
      .mockImplementationOnce(mockRun(sessionStream("ses_after_retry")) as never);

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const byAttempt = checkpoints().map((event) => ({
      attempt: event.payload?.attempt,
      sessionId: event.payload?.sessionId,
    }));
    expect(byAttempt).toEqual([{ attempt: 2, sessionId: "ses_after_retry" }]);

    const recovery = recoveries();
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.payload).toMatchObject({
      outcome: "fresh_missing",
      sessionId: RECORDED_SESSION_ID,
    });
  });

  // OpenCode has no named session-start event: the id rides on whichever event
  // carries `sessionID` first, so the latch must re-parse the accumulated
  // buffer rather than watch for a type. The checkpoint must fire only once
  // the line naming the id is complete, never on a chunk boundary landing
  // mid-token (server-utils.ts:3483-3497 delivers bytes, not lines).
  it("fires the checkpoint only once the split session line completes", async () => {
    const textLine = JSON.stringify({
      type: "text",
      sessionID: "ses_split_mid_token",
      part: { text: "working" },
    });
    const full = [textLine, sessionStream("ses_split_mid_token").split("\n")[1]].join("\n");
    // Split inside the sessionID value's characters, not at a JSON delimiter.
    const splitPoint = textLine.indexOf("ses_split_mid_token") + 6;

    runProcessMock.mockImplementation((async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      procOpts: ProcOpts,
    ) => {
      expect(checkpoints()).toHaveLength(0);
      await procOpts.onLog("stdout", full.slice(0, splitPoint));
      // The line naming the session id is not complete yet.
      expect(checkpoints()).toHaveLength(0);
      await procOpts.onLog("stdout", full.slice(splitPoint));
      expect(checkpoints()).toHaveLength(1);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: full,
        stderr: "",
        pid: 555,
        startedAt: new Date().toISOString(),
      };
    }) as never);

    await execute(buildCtx() as never);

    const recorded = checkpoints();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ attempt: 1, sessionId: "ses_split_mid_token" });
  });

  // Fire-and-forget by design: a checkpoint sink that never resolves must not
  // stall the run.
  it("does not stall on a checkpoint sink that never resolves", async () => {
    runProcessMock.mockImplementation(mockRun(sessionStream("ses_no_stall")) as never);
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
  // into a bogus session id.
  it("does not let attempt 1's incomplete trailing fragment leak into attempt 2's parse", async () => {
    const danglingFragment = '{"type":"text","sessionID":"leaked-partial';

    runProcessMock
      .mockImplementationOnce((async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        procOpts: ProcOpts,
      ) => {
        await procOpts.onLog("stdout", danglingFragment);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `Error: unknown session ${RECORDED_SESSION_ID}`,
          pid: 555,
          startedAt: new Date().toISOString(),
        };
      }) as never)
      .mockImplementationOnce(mockRun(sessionStream("ses_after_retry_leak_check")) as never);

    await execute(
      buildCtx({
        sessionId: RECORDED_SESSION_ID,
        sessionParams: { sessionId: RECORDED_SESSION_ID, cwd: workspace },
      }) as never,
    );

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const allSessionIds = checkpoints().map((event) => event.payload?.sessionId);
    expect(allSessionIds.some((id) => typeof id === "string" && id.includes("leaked"))).toBe(false);
    expect(allSessionIds).toContain("ses_after_retry_leak_check");
  });

  // The captured `stdout` is only the last MAX_CAPTURE_BYTES of the stream
  // (appendWithCap in server-utils.ts), so on any run long enough to matter the
  // first id-carrying event has scrolled out of it and parsing the capture
  // finds no session id — on success as much as on failure. The latch read it
  // from the first chunk, and finalization has to ask the latch.
  it("resolves the session id from the latch when it has scrolled out of the captured stdout", async () => {
    const full = sessionStream("ses_scrolled_off");
    // What the runner returns keeps only the tail, exactly as the cap leaves it,
    // with the `sessionID` field stripped from it as well.
    const capturedTail = JSON.stringify({ type: "step_finish", part: { tokens: { input: 1, output: 1, cache: { read: 0 } }, cost: 0 } });

    runProcessMock.mockImplementation((async (
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
        pid: 555,
        startedAt: new Date().toISOString(),
      };
    }) as never);

    const result = await execute(buildCtx() as never);

    expect(result.sessionId).toBe("ses_scrolled_off");
    expect(result.sessionParams).toMatchObject({ sessionId: "ses_scrolled_off", cwd: workspace });
    expect(result.sessionDisplayId).toBe("ses_scrolled_off");
  });

  // The headline regression. A timed-out result that names neither sessionId
  // nor sessionParams is not neutral: resolveNextSessionState falls back to the
  // pre-dispatch snapshot — null on a first run — and writes it over the
  // checkpoint this run just persisted. Timeout is the common case the whole
  // mechanism exists for.
  it("carries the streamed session out of a timeout instead of deleting its own checkpoint", async () => {
    const firstLine = JSON.stringify({
      type: "text",
      sessionID: "ses_timed_out",
      part: { text: "working" },
    });

    runProcessMock.mockImplementation((async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      procOpts: ProcOpts,
    ) => {
      await procOpts.onLog("stdout", firstLine);
      return {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        stdout: firstLine,
        stderr: "",
        pid: 555,
        startedAt: new Date().toISOString(),
      };
    }) as never);

    const result = await execute(buildCtx() as never);

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe("ses_timed_out");
    expect(result.sessionParams).toMatchObject({ sessionId: "ses_timed_out", cwd: workspace });
    expect(result.clearSession).toBe(false);
  });

  // OpenCode cannot be handed a session id, so a run killed before it named one
  // has nothing to keep. The result must stay silent about the session rather
  // than inventing one, which leaves the pre-dispatch params in place.
  it("names no session when a timeout arrives before the harness named one", async () => {
    runProcessMock.mockImplementation((async () => ({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 555,
      startedAt: new Date().toISOString(),
    })) as never);

    const result = await execute(buildCtx() as never);

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
  });
});
