import fs from "node:fs";
import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectDatabaseBackupHealth,
  invalidateDatabaseBackupHealthCache,
} from "./database-backup-health.js";

// Pass-through spies: the assertions below count filesystem calls, so the
// scan has to do real work against real temp directories while staying
// observable. A check that still used the synchronous `node:fs` API would
// bypass these entirely and every call count would read zero.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(actual.stat),
  };
});

const readdirMock = vi.mocked(readdir);
const readFileMock = vi.mocked(readFile);
const statMock = vi.mocked(stat);

/**
 * `node:fs`'s own promise API is not mocked, so it is the real implementation a
 * test can be restored to. `vi.clearAllMocks` only clears call history, so
 * without this an override in one test would leak into the next.
 */
function restoreRealFilesystem(): void {
  readdirMock.mockImplementation(fs.promises.readdir as typeof readdir);
  readFileMock.mockImplementation(fs.promises.readFile as typeof readFile);
  statMock.mockImplementation(fs.promises.stat as typeof stat);
}

const NOW = new Date("2026-07-06T13:00:00.000Z");

function makeBackupDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-backup-health-"));
}

function writeBackup(backupDir: string, name: string, mtime: Date): string {
  const file = path.join(backupDir, name);
  fs.writeFileSync(file, "backup");
  fs.utimesSync(file, mtime, mtime);
  return file;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resolves on the next event loop turn. */
const TICK = Symbol("tick");
function tick(): Promise<typeof TICK> {
  return new Promise((resolve) => setImmediate(() => resolve(TICK)));
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

/** Backup-file stats only, ignoring the failure-marker probes. */
function backupStatCount(): number {
  return statMock.mock.calls.filter((call) => String(call[0]).endsWith(".sql.gz")).length;
}

describe("inspectDatabaseBackupHealth", () => {
  beforeEach(() => {
    invalidateDatabaseBackupHealthCache();
    vi.clearAllMocks();
    restoreRealFilesystem();
    // Only Date is faked: the TTL is wall-clock driven, while `setImmediate`
    // and the filesystem promises have to keep working for real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    invalidateDatabaseBackupHealthCache();
  });

  it("reports a recent backup as ok", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result).toMatchObject({
      enabled: true,
      status: "ok",
      backupDir,
      maxAgeHours: 26,
      latestBackup: {
        name: "paperclip-20260706-031702.sql.gz",
        path: path.join(backupDir, "paperclip-20260706-031702.sql.gz"),
        mtime: "2026-07-06T03:17:02.000Z",
        ageHours: 9.7,
        sizeBytes: 6,
      },
      lastFailure: null,
      warnings: [],
    });
  });

  it("reports a backup older than the threshold as stale", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260705-031702.sql.gz", new Date("2026-07-05T03:17:02.000Z"));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.status).toBe("warning");
    expect(result.latestBackup?.ageHours).toBe(33.7);
    expect(result.warnings).toEqual([
      {
        code: "database_backup_stale",
        message: "Latest database backup is 33.7h old, exceeding 26h.",
      },
    ]);
  });

  it("raises the maximum age to at least an hour", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-125500.sql.gz", new Date("2026-07-06T12:55:00.000Z"));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 0,
      now: NOW,
    });

    expect(result.maxAgeHours).toBe(1);
    expect(result.status).toBe("ok");
  });

  it("treats a backup directory that does not exist as missing, not as a failed check", async () => {
    const backupDir = path.join(makeBackupDir(), "never-created");

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.latestBackup).toBeNull();
    expect(result.warnings).toEqual([
      {
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${backupDir}.`,
      },
    ]);
  });

  it("treats a backup directory with no archives as missing", async () => {
    const backupDir = makeBackupDir();
    fs.writeFileSync(path.join(backupDir, "notes.txt"), "not a backup");

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.latestBackup).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toEqual(["database_backup_missing"]);
  });

  it("reports the failure marker beside the backup directory", async () => {
    const backupRoot = makeBackupDir();
    const backupDir = path.join(backupRoot, "backups");
    fs.mkdirSync(backupDir);
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));
    const alertFile = path.join(backupRoot, "db-backup-to-s3.failure");
    fs.writeFileSync(alertFile, "db-backup-to-s3 failed at 2026-07-06T03:17:00.000Z exit=1\nstack\n");

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.status).toBe("warning");
    expect(result.lastFailure).toMatchObject({
      path: alertFile,
      message: "db-backup-to-s3 failed at 2026-07-06T03:17:00.000Z exit=1",
    });
    expect(result.warnings).toEqual([
      {
        code: "database_backup_last_failure",
        message: "db-backup-to-s3 failed at 2026-07-06T03:17:00.000Z exit=1",
      },
    ]);
  });

  it("falls back to a generic message for an empty failure marker", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));
    fs.writeFileSync(path.join(backupDir, "db-backup-to-s3.failure"), "   \n");

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.lastFailure?.message).toBe("Database backup failure marker is present.");
  });

  it("selects the newest backup by mtime, not by filename", async () => {
    const backupDir = makeBackupDir();
    // Backup filenames are built from local-time fields, so a DST fall-back or
    // a prefix change makes name order disagree with time order. mtime decides.
    writeBackup(backupDir, "paperclip-20260706-013000.sql.gz", new Date("2026-07-06T12:00:00.000Z"));
    writeBackup(backupDir, "paperclip-20260706-023000.sql.gz", new Date("2026-07-06T02:00:00.000Z"));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.latestBackup?.name).toBe("paperclip-20260706-013000.sql.gz");
    expect(result.latestBackup?.ageHours).toBe(1);
  });

  it("skips a backup deleted between the listing and its stat", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-021702.sql.gz", new Date("2026-07-06T02:17:02.000Z"));
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));
    // Retention pruning runs in this same process and can delete a listed entry
    // while the scan is awaiting. That is not a broken health check.
    statMock.mockImplementationOnce(() => Promise.reject(errno("ENOENT", "pruned mid-scan")));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.latestBackup).not.toBeNull();
  });

  it("reports an unreadable backup directory as a failed check", async () => {
    const backupDir = makeBackupDir();
    readdirMock.mockImplementationOnce(() => Promise.reject(errno("EACCES", "permission denied")));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.status).toBe("warning");
    expect(result.warnings).toEqual([
      {
        code: "database_backup_check_failed",
        message: "Database backup health check failed: permission denied",
      },
    ]);
  });

  it("keeps the event loop free while a filesystem read is outstanding", async () => {
    const backupDir = makeBackupDir();
    const backupFile = writeBackup(
      backupDir,
      "paperclip-20260706-031702.sql.gz",
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const held = deferred<Stats>();
    statMock.mockImplementationOnce(() => held.promise);

    const pending = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    // The inspection is still outstanding, yet the event loop has turned. A
    // synchronous implementation could neither be observed mid-scan nor let an
    // unrelated callback run before it finished.
    await expect(Promise.race([pending, tick()])).resolves.toBe(TICK);

    held.resolve(fs.statSync(backupFile));
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");
  });

  it("issues the per-backup stats together instead of one round trip at a time", async () => {
    const backupDir = makeBackupDir();
    for (let index = 0; index < 5; index += 1) {
      writeBackup(
        backupDir,
        `paperclip-20260706-03170${index}.sql.gz`,
        new Date(`2026-07-06T03:17:0${index}.000Z`),
      );
    }
    const gate = deferred<void>();
    const issued: string[] = [];
    statMock.mockImplementation(async (target) => {
      issued.push(String(target));
      await gate.promise;
      return fs.statSync(String(target));
    });

    const pending = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    // Every stat is outstanding at once while none has answered. Awaiting them
    // one at a time would leave the scan O(retained backups) round trips deep,
    // which on a network-backed filesystem is the whole cost being removed.
    await vi.waitFor(() => expect(issued.length).toBe(5), { timeout: 2_000, interval: 5 });

    gate.resolve();
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.latestBackup?.name).toBe("paperclip-20260706-031704.sql.gz");
  });

  it("collapses concurrent inspections into a single filesystem scan", async () => {
    const backupDir = makeBackupDir();
    for (let index = 0; index < 20; index += 1) {
      writeBackup(
        backupDir,
        `paperclip-20260706-0317${String(index).padStart(2, "0")}.sql.gz`,
        new Date(`2026-07-06T03:17:${String(index).padStart(2, "0")}.000Z`),
      );
    }
    const opts = { enabled: true, backupDir, maxAgeHours: 26, now: NOW } as const;

    const results = await Promise.all([
      inspectDatabaseBackupHealth(opts),
      inspectDatabaseBackupHealth(opts),
      inspectDatabaseBackupHealth(opts),
      inspectDatabaseBackupHealth(opts),
      inspectDatabaseBackupHealth(opts),
    ]);

    expect(results.every((result) => result.status === "ok")).toBe(true);
    // Five probes arriving together, one listing and one stat per backup. A
    // per-request scan would be 5 listings and 100 stats.
    expect(readdirMock).toHaveBeenCalledTimes(1);
    expect(backupStatCount()).toBe(20);
  });

  it("reuses one observation across polls and re-scans after the cache expires", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));
    const opts = { enabled: true, backupDir, maxAgeHours: 26, now: NOW } as const;

    await inspectDatabaseBackupHealth(opts);
    vi.setSystemTime(new Date(NOW.getTime() + 25_000));
    await inspectDatabaseBackupHealth(opts);
    expect(readdirMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    await inspectDatabaseBackupHealth(opts);
    expect(readdirMock).toHaveBeenCalledTimes(2);
  });

  it("recomputes staleness from a cached observation", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-120000.sql.gz", new Date("2026-07-06T12:00:00.000Z"));
    const opts = { enabled: true, backupDir, maxAgeHours: 26 };

    const fresh = await inspectDatabaseBackupHealth({ ...opts, now: NOW });
    expect(fresh.status).toBe("ok");

    // Same cached observation, later instant: the age and the staleness verdict
    // are derived per call, so caching cannot report a backup as fresher than
    // it is.
    const later = await inspectDatabaseBackupHealth({
      ...opts,
      now: new Date(NOW.getTime() + 40 * 3_600_000),
    });
    expect(readdirMock).toHaveBeenCalledTimes(1);
    expect(later.status).toBe("warning");
    expect(later.warnings.map((warning) => warning.code)).toEqual(["database_backup_stale"]);
    expect(later.latestBackup?.ageHours).toBe(41);
  });

  it("does not serve a failed scan as healthy, and clears it on invalidation", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));
    const opts = { enabled: true, backupDir, maxAgeHours: 26, now: NOW } as const;
    readdirMock.mockImplementationOnce(() => Promise.reject(errno("EIO", "input/output error")));

    const failed = await inspectDatabaseBackupHealth(opts);
    expect(failed.warnings.map((warning) => warning.code)).toEqual(["database_backup_check_failed"]);

    // The failure is what is cached; the cache never upgrades it to "ok".
    const repeated = await inspectDatabaseBackupHealth(opts);
    expect(repeated.warnings.map((warning) => warning.code)).toEqual(["database_backup_check_failed"]);
    expect(readdirMock).toHaveBeenCalledTimes(1);

    // A backup attempt clears it without waiting the window out.
    invalidateDatabaseBackupHealthCache();
    const recovered = await inspectDatabaseBackupHealth(opts);
    expect(recovered.status).toBe("ok");
    expect(readdirMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a scan that was invalidated while it was running", async () => {
    const backupDir = makeBackupDir();
    const backupFile = writeBackup(
      backupDir,
      "paperclip-20260706-031702.sql.gz",
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const held = deferred<Stats>();
    statMock.mockImplementationOnce(() => held.promise);
    const opts = { enabled: true, backupDir, maxAgeHours: 26, now: NOW } as const;

    const pending = inspectDatabaseBackupHealth(opts);
    // A backup completes while the scan is in flight.
    invalidateDatabaseBackupHealthCache();
    held.resolve(fs.statSync(backupFile));

    // The in-flight scan still answers its caller with a real observation...
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(readdirMock).toHaveBeenCalledTimes(1);

    // ...but it did not become the cached answer, so the next poll re-scans.
    await inspectDatabaseBackupHealth(opts);
    expect(readdirMock).toHaveBeenCalledTimes(2);
  });

  it("re-scans when the inspected directory changes", async () => {
    const first = makeBackupDir();
    const second = makeBackupDir();
    writeBackup(first, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));
    writeBackup(second, "paperclip-20260706-041702.sql.gz", new Date("2026-07-06T04:17:02.000Z"));

    const a = await inspectDatabaseBackupHealth({ enabled: true, backupDir: first, maxAgeHours: 26, now: NOW });
    const b = await inspectDatabaseBackupHealth({ enabled: true, backupDir: second, maxAgeHours: 26, now: NOW });

    expect(a.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");
    expect(b.latestBackup?.name).toBe("paperclip-20260706-041702.sql.gz");
    expect(readdirMock).toHaveBeenCalledTimes(2);
  });

  it("echoes the enabled flag it was given", async () => {
    const backupDir = makeBackupDir();
    writeBackup(backupDir, "paperclip-20260706-031702.sql.gz", new Date("2026-07-06T03:17:02.000Z"));

    const result = await inspectDatabaseBackupHealth({
      enabled: false,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.enabled).toBe(false);
  });
});
