/** Serialize provisional writes and close admission before final session persistence. */
export function createSessionCheckpointQueue() {
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  return {
    enqueue(write: () => Promise<void>): Promise<void> {
      if (closed) return Promise.resolve();
      const pending = tail.then(write);
      // One failed checkpoint must not discard later checkpoints. The caller
      // still receives the failure through the original promise.
      tail = pending.catch(() => {});
      return pending;
    },
    async settle(): Promise<void> {
      closed = true;
      await tail;
    },
  };
}
