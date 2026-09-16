/**
 * Adapter types treated as built in. External plugins must not replace these.
 *
 * Two halves. `CORE_BUILTIN_ADAPTER_TYPES` is compiled in and is the fixed
 * point: configuration can never name one (see `configured-builtin-adapters.ts`).
 * `adapters.builtin` in the managed config contributes the rest, for adapter
 * packages a distributor ships in its own image.
 *
 * The exported set must be COMPLETE FROM ITS FIRST READ or the protection is
 * racy: `registry.ts` consults it synchronously for override bookkeeping and
 * for `unregisterServerAdapter`'s refusal, and four guards in
 * `routes/adapters.ts` do the same. Parsing the managed config is pure and
 * synchronous (an env read and `JSON.parse`), so the *types* are known at
 * module init even though loading the modules is async — which is why this
 * file declares types and `registry.ts` loads code.
 */

import { getManagedInstanceConfig } from "../services/managed-config.js";

/** Adapter types compiled into this build. */
export const CORE_BUILTIN_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "paperclip_runner",
  "cursor_cloud",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "process",
  "http",
]);

// A parse error is CAPTURED, not thrown. `index.ts` owns the fail-closed log
// path for a malformed PAPERCLIP_MANAGED_CONFIG, and throwing at import time
// would bypass it — the same hazard the comment on that parse block warns
// about for `instanceSettingsService`. The error is re-raised by
// `assertConfiguredBuiltinAdapterTypesValid()`, called from startup and from
// `createApp` so test entry points are covered too.
let configuredTypeError: unknown = null;
let configuredTypes: readonly string[] = [];
try {
  configuredTypes = (getManagedInstanceConfig(process.env)?.adapters.builtin ?? []).map(
    (entry) => entry.type,
  );
} catch (err) {
  configuredTypeError = err;
}

export const BUILTIN_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  ...CORE_BUILTIN_ADAPTER_TYPES,
  ...configuredTypes,
]);

/**
 * Re-raise a managed-config parse error swallowed at module init, so the
 * instance refuses to start on a malformed document instead of running with a
 * silently core-only set of protected types.
 */
export function assertConfiguredBuiltinAdapterTypesValid(): void {
  if (configuredTypeError) throw configuredTypeError;
}
