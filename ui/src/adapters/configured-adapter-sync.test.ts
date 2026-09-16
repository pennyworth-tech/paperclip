import { afterEach, describe, expect, it } from "vitest";
import type { AdapterInfo } from "@/api/adapters";
import { getUIAdapter, listUIAdapters, syncServerAdapters } from "./registry";
import { processUIAdapter } from "./process";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "./schema-config-fields";

/**
 * The listing filter that decides which server adapters reach the UI registry.
 * Kept in step with `use-disabled-adapters.ts` — the hook itself needs React
 * and a query client, but the predicate is the part with the bug potential.
 */
function syncFromListing(adapters: Pick<AdapterInfo, "type" | "label" | "source">[]): void {
  syncServerAdapters(
    adapters
      .filter((a) => a.source === "external" || a.source === "configured")
      .map((a) => ({ type: a.type, label: a.label })),
  );
}

afterEach(() => {
  syncServerAdapters([]);
});

describe("server adapter listing sync", () => {
  // The gap this closes: a server built-in declared by configuration has no
  // compiled-in module in this bundle, so without being synced it is
  // registered on the server and absent from every adapter picker.
  it("registers a configured server built-in so it reaches the picker", () => {
    expect(listUIAdapters().some((a) => a.type === "my_adapter")).toBe(false);

    syncFromListing([{ type: "my_adapter", label: "My Adapter", source: "configured" }]);

    expect(listUIAdapters().some((a) => a.type === "my_adapter")).toBe(true);
    const adapter = getUIAdapter("my_adapter");
    expect(adapter.label).toBe("My Adapter");
    // Config comes from the server's schema and stdout parsing falls back to
    // the process parser until a dynamic parser loads — the same bridge an
    // external gets, which is why no per-adapter UI module is needed.
    expect(adapter.ConfigFields).toBe(SchemaConfigFields);
    expect(adapter.buildAdapterConfig).toBe(buildSchemaAdapterConfig);
    expect(adapter.parseStdoutLine("hello", "2026-01-01T00:00:00Z")).toEqual(
      processUIAdapter.parseStdoutLine("hello", "2026-01-01T00:00:00Z"),
    );
  });

  it("still registers a runtime-installed external adapter", () => {
    syncFromListing([{ type: "droid_local", label: "Droid", source: "external" }]);
    expect(listUIAdapters().some((a) => a.type === "droid_local")).toBe(true);
  });

  // Regression guard: the predicate must stay a SOURCE test. Replacing it with
  // "types this bundle has no module for" would make the synced set disjoint
  // from the builtin types, and the builtin-override lifecycle — the first of
  // the two concerns syncServerAdapters handles — could never activate.
  it("keeps an external override of a compiled-in type flowing through", () => {
    const builtin = getUIAdapter("hermes_local");
    syncFromListing([{ type: "hermes_local", label: "External Hermes", source: "external" }]);
    expect(getUIAdapter("hermes_local")).not.toBe(builtin);
    syncFromListing([]);
    expect(getUIAdapter("hermes_local")).toBe(builtin);
  });

  // A plain compiled-in adapter is not a "type the server has and this bundle
  // does not", so it must not be bridged — doing so would replace its real
  // parser with the generic one.
  it("leaves a plain compiled-in adapter alone", () => {
    const builtin = getUIAdapter("claude_local");
    syncFromListing([{ type: "claude_local", label: "Claude Code", source: "builtin" }]);
    expect(getUIAdapter("claude_local")).toBe(builtin);
  });
});
