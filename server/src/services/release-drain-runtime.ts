import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const releaseDrainHostId = randomUUID();
export const releaseDrainRequestSchema = z.object({
  ownerId: z.string().min(1).max(200),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const releaseDrainInterruptSchema = releaseDrainRequestSchema.extend({
  runIds: z.array(z.string().uuid()).min(1).max(100),
  graceMs: z.number().int().min(1).max(30_000).default(2_000),
}).strict();
export const releaseDrainReceiptSchema = releaseDrainRequestSchema.extend({
  schemaVersion: z.literal(1),
  hostId: z.string().uuid(),
  observedAt: z.string().datetime(),
  quiescent: z.boolean(),
  locallyQuiescent: z.boolean(),
  pendingHostIds: z.array(z.string()),
  runningCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  localProcessRunIds: z.array(z.string()),
  processRunIds: z.array(z.string()),
  inFlightExecutions: z.number().int().nonnegative(),
  lifecycleOperations: z.number().int().nonnegative(),
  suppressionAcknowledged: z.boolean(),
  leaseIds: z.array(z.string()),
  unknown: z.array(z.string()),
  devcontainerIds: z.array(z.string()),
  liveServiceIds: z.array(z.string()),
  orphanCleanupCount: z.number().int().nonnegative(),
}).strict();
export type ReleaseDrainRequest = z.infer<typeof releaseDrainRequestSchema>;

// Shared by route and scheduler service instances in this Node process.
const activeOperations = new Set<symbol>();
let interruptionTail: Promise<unknown> = Promise.resolve();
export function serializeReleaseDrainInterruption<T>(operation: () => Promise<T>): Promise<T> {
  const next = interruptionTail.then(operation, operation);
  interruptionTail = next.catch(() => undefined);
  return next;
}
export const unpersistedReleaseDrainOrphans = new Set<object>();
export function releaseDrainOperationCount() { return activeOperations.size; }
export async function trackReleaseDrainOperation<T>(operation: () => Promise<T>): Promise<T> {
  const id = Symbol();
  activeOperations.add(id);
  try { return await operation(); } finally { activeOperations.delete(id); }
}

export function inspectReleaseDrainProcess(pid: number | null | undefined, group = false) {
  if (pid == null) return "absent" as const;
  if (!Number.isSafeInteger(pid) || pid <= 0 || (group && process.platform === "win32")) return "unknown" as const;
  try {
    process.kill(group ? -pid : pid, 0);
    return "alive" as const;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" as const : "unknown" as const;
  }
}

const execFileAsync = promisify(execFile);
async function directoryEntries(directory: string): Promise<string[] | null> {
  try { return await fs.readdir(directory); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

export async function inspectReleaseDrainResources(env: NodeJS.ProcessEnv = process.env) {
  const unknown: string[] = [];
  const root = resolvePaperclipInstanceRoot();
  const orphanFiles = await directoryEntries(env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR ?? path.join(root, "data", "sandbox-orphan-cleanup"));
  const serviceFiles = await directoryEntries(path.join(root, "runtime-services"));
  if (orphanFiles === null) unknown.push("orphan_cleanup_spool_unreadable");
  if (serviceFiles === null) unknown.push("local_service_registry_unreadable");
  const liveServiceIds: string[] = [];
  for (const file of serviceFiles ?? []) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(root, "runtime-services", file), "utf8"));
      if (!record.pid || !record.serviceKey) {
        unknown.push("local_service_identity_unknown");
      } else if (inspectReleaseDrainProcess(record.pid) !== "absent" || inspectReleaseDrainProcess(record.processGroupId, true) !== "absent") {
        liveServiceIds.push(record.serviceKey);
      }
    } catch { unknown.push("local_service_record_unreadable"); }
  }
  // Inspect the complete execution daemon. An unlabeled container has unknown
  // ownership and must block too; a label filter would silently omit it.
  let devcontainerIds: string[] = [];
  if (env.PAPERCLIP_RELEASE_DRAIN_DOCKER === "none" && !env.DOCKER_HOST) {
    // Explicit operator declaration for hosts with no Docker execution domain.
  } else if (env.DOCKER_HOST || env.PAPERCLIP_RELEASE_DRAIN_DOCKER === "enabled") {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps", "--no-trunc", "--format", "{{.ID}}",
      ], { timeout: 5_000, maxBuffer: 1024 * 1024, env });
      devcontainerIds = stdout.trim().split(/\s+/).filter(Boolean);
      if (devcontainerIds.some((id) => !/^[a-f0-9]{64}$/.test(id))) unknown.push("devcontainer_inventory_invalid");
    } catch { unknown.push("devcontainer_inventory_unavailable"); }
  } else {
    unknown.push("docker_execution_domain_undeclared");
  }
  return {
    unknown,
    devcontainerIds,
    liveServiceIds,
    orphanCleanupCount: (orphanFiles?.length ?? 0) + unpersistedReleaseDrainOrphans.size,
  };
}
