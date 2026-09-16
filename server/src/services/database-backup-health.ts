import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale";

export type DatabaseBackupHealthWarning = {
  code: DatabaseBackupHealthWarningCode;
  message: string;
};

export type DatabaseBackupHealthStatus = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir: string;
  maxAgeHours: number;
  latestBackup: {
    name: string;
    path: string;
    mtime: string;
    ageHours: number;
    sizeBytes: number;
  } | null;
  lastFailure: {
    path: string;
    mtime: string;
    message: string;
  } | null;
  warnings: DatabaseBackupHealthWarning[];
};

export type InspectDatabaseBackupHealthOptions = {
  enabled: boolean;
  backupDir: string;
  maxAgeHours: number;
  alertFile?: string;
  alertFiles?: string[];
  now?: Date;
};

/**
 * What one filesystem scan observed, with every time-dependent derivation left
 * out. Only this is cached; `ageHours`, the staleness verdict and the warning
 * list are recomputed from `opts.now` on every call. That split is what makes
 * caching safe here: a cached observation can never make a backup look fresher
 * than it is, and a backup that crosses the staleness threshold while the
 * observation is cached is still reported stale.
 */
type BackupHealthSnapshot = {
  latestBackup: { name: string; path: string; mtimeMs: number; sizeBytes: number } | null;
  lastFailure: { path: string; mtimeMs: number; message: string } | null;
  /** Message of the error that aborted the scan, or null when it completed. */
  error: string | null;
};

/**
 * How long one filesystem observation is reused.
 *
 * `/api/health` is polled continuously by liveness and startup probes, and the
 * backup directory sits under an operator-chosen instance root that may be a
 * network-backed filesystem (a FUSE mount over object storage, NFS, SMB). One
 * directory listing plus one stat per retained backup per probe is pure
 * overhead there: the answer changes at most once per backup interval, which is
 * typically hourly.
 *
 * 30s is far below the resolution of the signal it feeds — the staleness
 * threshold is measured in hours and `ageHours` is rounded to 6 minutes — and
 * far above the 5-10s period of a typical probe, so the common case is a hit.
 * Because a backup taken by this process invalidates the cache directly, the
 * only thing the window delays is discovery of a change made from outside the
 * process: an externally written failure marker, a restored or copied file, or
 * out-of-band pruning.
 */
const DATABASE_BACKUP_HEALTH_CACHE_TTL_MS = 30_000;

/**
 * One entry is enough: a process inspects exactly one backup directory. The key
 * still guards the entry so a differently configured call re-scans and replaces
 * it rather than reading another directory's observation.
 */
let snapshotCache: { key: string; snapshot: BackupHealthSnapshot; expiresAtMs: number } | null = null;
/** The scan every concurrent caller joins, so N probes cost one directory scan. */
let inFlightScan: { key: string; promise: Promise<BackupHealthSnapshot> } | null = null;
/** Bumped by invalidation so a scan started before it cannot repopulate the cache. */
let scanEpoch = 0;

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function alertFileCandidates(opts: InspectDatabaseBackupHealthOptions) {
  return [...new Set([
    opts.alertFile,
    ...(opts.alertFiles ?? []),
    join(opts.backupDir, "db-backup-to-s3.failure"),
    resolve(opts.backupDir, "..", "db-backup-to-s3.failure"),
  ].filter((value): value is string => Boolean(value)))];
}

async function readLastFailure(alertFiles: string[]) {
  const markers = await Promise.all(alertFiles.map(async (alertFile) => {
    try {
      const [entry, contents] = await Promise.all([
        stat(alertFile),
        readFile(alertFile, "utf8"),
      ]);
      return {
        path: alertFile,
        mtimeMs: entry.mtimeMs,
        message: contents.trim().split(/\r?\n/)[0] || "Database backup failure marker is present.",
      };
    } catch (error) {
      // An absent marker is the healthy case, not a failed check.
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
  }));

  // Newest marker wins; ties keep candidate order, as the previous sort did.
  let latest: { path: string; mtimeMs: number; message: string } | null = null;
  for (const marker of markers) {
    if (marker && (!latest || marker.mtimeMs > latest.mtimeMs)) latest = marker;
  }
  return latest;
}

async function findLatestBackup(backupDir: string) {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    // An instance that has never taken a backup has no backup directory. That
    // is the "no backups yet" case the caller reports as
    // `database_backup_missing`; any other error (an unreadable directory, for
    // instance) is a genuinely failed check and propagates.
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }

  // Issued concurrently rather than one at a time: on a network-backed
  // filesystem each stat is a round trip, and awaiting them in sequence would
  // make the scan O(retained backups) round trips deep. Actual parallelism is
  // bounded by libuv's threadpool (4 by default), which is the point — it keeps
  // a large backup directory from flooding the pool while still collapsing the
  // scan to a small number of sequential waits.
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".sql.gz"))
      .map(async (name) => {
        const fullPath = join(backupDir, name);
        try {
          const entry = await stat(fullPath);
          return { fullPath, mtimeMs: entry.mtimeMs, sizeBytes: entry.size };
        } catch (error) {
          // Retention pruning deletes backups from this same process, so an
          // entry that was listed a moment ago can be gone before it is
          // stat-ed. It is no longer a backup: skip it rather than failing the
          // whole check.
          if (isErrnoCode(error, "ENOENT")) return null;
          throw error;
        }
      }),
  );

  // Newest by mtime, not by filename. Backup filenames are built from
  // local-time fields and carry an operator-configurable prefix, so their
  // lexicographic order is not their chronological order across a DST
  // transition or a prefix change — and mtime is the right answer anyway for a
  // directory that has been restored or copied into place.
  let latest: { fullPath: string; mtimeMs: number; sizeBytes: number } | null = null;
  for (const entry of entries) {
    if (entry && (!latest || entry.mtimeMs > latest.mtimeMs)) latest = entry;
  }
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtimeMs: latest.mtimeMs,
    sizeBytes: latest.sizeBytes,
  };
}

async function scanBackupHealth(opts: InspectDatabaseBackupHealthOptions): Promise<BackupHealthSnapshot> {
  let latestBackup: BackupHealthSnapshot["latestBackup"] = null;

  try {
    latestBackup = await findLatestBackup(opts.backupDir);
    const lastFailure = await readLastFailure(alertFileCandidates(opts));
    return { latestBackup, lastFailure, error: null };
  } catch (error) {
    // Whatever was observed before the failure is kept, matching the reporting
    // this check has always done: a readable backup directory is still reported
    // when only the marker read failed.
    return {
      latestBackup,
      lastFailure: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function observeBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): BackupHealthSnapshot | Promise<BackupHealthSnapshot> {
  const key = JSON.stringify([opts.backupDir, ...alertFileCandidates(opts)]);
  // TTL bookkeeping reads the wall clock directly and never `opts.now`: `now`
  // is an injected instant used to date the observation, and letting it drive
  // expiry would make a caller that passes a fixed instant either never or
  // always expire the entry.
  const cached = snapshotCache;
  if (cached && cached.key === key && Date.now() < cached.expiresAtMs) return cached.snapshot;

  const pending = inFlightScan;
  if (pending && pending.key === key) return pending.promise;

  const startedEpoch = scanEpoch;
  const promise = scanBackupHealth(opts)
    .then((snapshot) => {
      // A scan that was invalidated while it ran still answers its callers —
      // they asked for an observation and this is a real one — but it does not
      // become the cached answer, so the next call re-scans and sees whatever
      // the invalidation was announcing.
      if (scanEpoch === startedEpoch) {
        snapshotCache = {
          key,
          snapshot,
          expiresAtMs: Date.now() + DATABASE_BACKUP_HEALTH_CACHE_TTL_MS,
        };
      }
      return snapshot;
    })
    .finally(() => {
      if (inFlightScan?.promise === promise) inFlightScan = null;
    });
  inFlightScan = { key, promise };
  return promise;
}

/**
 * Drop the cached observation so the next inspection re-reads the directory.
 *
 * Called after a backup attempt, on success and on failure alike: a run that
 * succeeded has written a backup and may have pruned others, and a run that
 * failed may have written a failure marker. Without this the health endpoint
 * would keep reporting the pre-run state for the rest of the TTL. It doubles as
 * the seam a test uses to change files without waiting the TTL out.
 */
export function invalidateDatabaseBackupHealthCache(): void {
  snapshotCache = null;
  scanEpoch += 1;
}

/**
 * Report the health of this instance's periodic database backups.
 *
 * Never rejects: a backup directory that cannot be read is reported as a
 * `database_backup_check_failed` warning, because a health endpoint that throws
 * is worse than one that says it could not look.
 *
 * The filesystem work is asynchronous and shared. It has to be asynchronous
 * because the backup directory lives under an operator-chosen instance root
 * that may be network-backed, where a blocking scan stalls the event loop and
 * therefore the whole server — including the probe that triggered it. It is
 * shared because the endpoint is polled continuously, and re-reading storage on
 * every poll is wasteful independently of how the reads are issued. Concurrent
 * callers join one in-flight scan and later callers reuse its result for
 * `DATABASE_BACKUP_HEALTH_CACHE_TTL_MS`.
 *
 * A failed scan is cached for that same window rather than retried on the next
 * poll: the scan most likely to fail is the one against sick or hanging
 * storage, so retrying it harder is backwards. The cost is that a one-off
 * filesystem error is reported for up to the TTL, which errs toward warning
 * rather than toward a false "ok", and any backup attempt clears it early.
 *
 * Deliberately not a stale-while-revalidate cache: refreshing in the background
 * would still pay the first scan in a request, and it would keep touching
 * possibly sick storage with nobody waiting on the answer. One slow scan per
 * TTL, with every concurrent caller sharing it, is the bound worth having.
 */
export async function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  let snapshot: BackupHealthSnapshot;
  try {
    snapshot = await observeBackupHealth(opts);
  } catch (error) {
    snapshot = {
      latestBackup: null,
      lastFailure: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  const latestBackup: DatabaseBackupHealthStatus["latestBackup"] = snapshot.latestBackup
    ? {
        name: snapshot.latestBackup.name,
        path: snapshot.latestBackup.path,
        mtime: new Date(snapshot.latestBackup.mtimeMs).toISOString(),
        ageHours: roundHours((now.getTime() - snapshot.latestBackup.mtimeMs) / 3_600_000),
        sizeBytes: snapshot.latestBackup.sizeBytes,
      }
    : null;
  const lastFailure: DatabaseBackupHealthStatus["lastFailure"] = snapshot.lastFailure
    ? {
        path: snapshot.lastFailure.path,
        mtime: new Date(snapshot.lastFailure.mtimeMs).toISOString(),
        message: snapshot.lastFailure.message,
      }
    : null;

  const warnings: DatabaseBackupHealthWarning[] = [];
  if (snapshot.error !== null) {
    warnings.push({
      code: "database_backup_check_failed",
      message: `Database backup health check failed: ${snapshot.error}`,
    });
  } else {
    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else if (latestBackup.ageHours > maxAgeHours) {
      warnings.push({
        code: "database_backup_stale",
        message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
      });
    }

    if (lastFailure) {
      warnings.push({
        code: "database_backup_last_failure",
        message: lastFailure.message,
      });
    }
  }

  return {
    enabled: opts.enabled,
    status: warnings.length > 0 ? "warning" : "ok",
    backupDir: opts.backupDir,
    maxAgeHours,
    latestBackup,
    lastFailure,
    warnings,
  };
}
