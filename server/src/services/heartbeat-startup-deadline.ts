/** A policy deadline requests cancellation; it is not evidence of provider death. */
export const LEGACY_STARTUP_DEADLINE_MS = 15 * 60 * 1000;
export function legacyStartupDeadlineExpired(run: {
  runtimeMode: string | null;
  startedAt: Date | string | null;
  processStartedAt: Date | string | null;
  processPid: number | null;
  processGroupId: number | null;
  lastOutputAt: Date | string | null;
}, now: Date): boolean {
  return run.runtimeMode === "legacy" && run.startedAt !== null &&
    run.processStartedAt === null && run.processPid === null &&
    run.processGroupId === null && run.lastOutputAt === null &&
    now.getTime() - new Date(run.startedAt).getTime() >= LEGACY_STARTUP_DEADLINE_MS;
}
