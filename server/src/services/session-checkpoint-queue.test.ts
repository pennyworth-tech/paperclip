import { describe, expect, it } from "vitest";
import { createSessionCheckpointQueue } from "./session-checkpoint-queue.js";

describe("checkpoint persistence ordering", () => {
  it("waits for an unawaited checkpoint and writes the final session last", async () => {
    const queue = createSessionCheckpointQueue();
    const writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue(async () => { await gate; writes.push("first attempt"); });
    const second = queue.enqueue(async () => { writes.push("retry attempt"); });
    const final = queue.settle().then(() => { writes.push("final result"); });
    await Promise.resolve();
    expect(writes).toEqual([]);
    release();
    await Promise.all([first, second, final]);
    expect(writes).toEqual(["first attempt", "retry attempt", "final result"]);
  });

  it("closes admission immediately, including while draining", async () => {
    const queue = createSessionCheckpointQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writes: string[] = [];
    void queue.enqueue(async () => { await gate; writes.push("admitted"); });
    const settled = queue.settle();
    await queue.enqueue(async () => { writes.push("late"); });
    release();
    await settled;
    await queue.enqueue(async () => { writes.push("after finalization"); });
    expect(writes).toEqual(["admitted"]);
  });

  it("keeps later checkpoints after an earlier persistence failure", async () => {
    const queue = createSessionCheckpointQueue();
    const failed = queue.enqueue(async () => { throw new Error("database unavailable"); });
    let persisted = false;
    const next = queue.enqueue(async () => { persisted = true; });
    await expect(failed).rejects.toThrow("database unavailable");
    await queue.settle();
    await next;
    expect(persisted).toBe(true);
  });
});
