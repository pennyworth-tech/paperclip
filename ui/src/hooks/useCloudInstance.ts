import { useQuery } from "@tanstack/react-query";
import { healthApi, type CloudInstanceHealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Reads Paperclip Cloud metadata from the app-wide health query cache.
 * CloudAccessGate owns the fetch; disabling this observer's query function
 * prevents consumers from adding another health request when they mount.
 */
export function useCloudInstance() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });

  return healthQuery.data?.cloud ?? null;
}

/**
 * Whether the instance sits behind the Paperclip Cloud app.
 *
 * `health.cloud` is advertised from the managed signal alone, and a
 * self-hosted instance that boots with `PAPERCLIP_MANAGED_CONFIG` (to elect its
 * bundled plugins and pin managed features) advertises it too — with no stack
 * and no cloud origin. Only a live stack behind the Cloud app carries
 * `cloudBaseUrl`, and only there do the Cloud-owned surfaces exist: the stack
 * portfolio, stack entry, and the `/cloud/logout` sequence. Anything that
 * navigates into the Cloud app keys on this, not on `cloud` being present;
 * the managed floors (no in-app company creation or import) key on `cloud`.
 */
export function hasCloudApp(cloud: CloudInstanceHealthStatus | null | undefined): boolean {
  return Boolean(cloud?.cloudBaseUrl);
}
