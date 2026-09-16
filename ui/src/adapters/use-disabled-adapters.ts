import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi } from "@/api/adapters";
import { setDisabledAdapterTypes } from "@/adapters/disabled-store";
import { syncServerAdapters } from "@/adapters/registry";
import { setRuntimeAdapterDisplay } from "@/adapters/adapter-display-registry";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fetch adapters and keep the disabled-adapter store + UI adapter registry
 * in sync with the server.
 *
 * - Registers external adapter types in the UI registry so they appear in
 *   dropdowns (done eagerly during render — idempotent, no React state).
 * - Syncs the disabled-adapter store for non-React consumers (useEffect).
 *
 * Returns a reactive Set of disabled types for use as useMemo dependencies.
 * Call this at the top of any component that renders adapter menus.
 */
export function useDisabledAdaptersSync(options: { enabled?: boolean } = {}): Set<string> {
  const enabled = options.enabled ?? true;
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  // Eagerly register server-side adapter types in the UI registry so that
  // consumers calling listUIAdapters() in the same render cycle see them.
  // This is idempotent — already-registered types are skipped.
  //
  // Both non-compiled-in sources are passed. `configured` adapters are server
  // built-ins declared by the managed config, so this bundle has no module for
  // them either and they need the same schema-driven bridge an external gets —
  // without this they would be registered on the server and absent from every
  // picker. The predicate stays a source test rather than "types this bundle
  // doesn't know": `syncServerAdapters` also drives the builtin-override
  // lifecycle, which needs to see externals that DO share a builtin type.
  if (adapters) {
    syncServerAdapters(
      adapters
        .filter((a) => a.source === "external" || a.source === "configured")
        .map((a) => ({
          type: a.type,
          label: a.label,
          disabled: a.disabled,
          overrideDisabled: a.overridePaused,
        })),
    );
    // Display metadata rides the response that is already being fetched, so
    // an adapter this bundle has no entry for can still show a real name.
    setRuntimeAdapterDisplay(
      adapters.map((a) => ({
        type: a.type,
        label: a.label,
        description: a.description,
        iconName: a.iconName,
      })),
    );
  }

  // Sync the disabled set to the global store for non-React code
  useEffect(() => {
    if (!adapters) return;
    setDisabledAdapterTypes(
      adapters.filter((a) => a.disabled).map((a) => a.type),
    );
  }, [adapters]);

  return useMemo(
    () => new Set(adapters?.filter((a) => a.disabled).map((a) => a.type) ?? []),
    [adapters],
  );
}

/**
 * Whether the adapter list has arrived, so callers can tell "this instance
 * does not offer that adapter" from "the registry has not loaded yet".
 *
 * External adapter types are registered into the UI registry by
 * {@link useDisabledAdaptersSync} only once the query resolves. Until then
 * `listUIAdapters()` returns the built-ins alone, so an external adapter looks
 * exactly like one the deployer has disabled.
 *
 * Deliberately reports arrival rather than settlement, unlike the fail-open
 * gates elsewhere in onboarding. The directions of harm are opposite here. A
 * caller that acts on an unloaded registry replaces the customer's chosen
 * adapter with a built-in and persists that choice; a caller that waits
 * forever simply leaves the selection alone, which is the behaviour that
 * existed before any of this. Silently changing a saved answer is the error
 * worth refusing to make.
 *
 * Reads the same query key as {@link useDisabledAdaptersSync}, so it shares
 * that cache entry rather than adding a request.
 */
export function useAdapterRegistryLoaded(options: { enabled?: boolean } = {}): boolean {
  const enabled = options.enabled ?? true;
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
  return adapters !== undefined;
}
