import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_CONFIG_ENV_KEY } from "../services/managed-config.js";

/**
 * `BUILTIN_ADAPTER_TYPES` is built once at module init, so every case here
 * re-imports the module under a fresh environment. That is the contract being
 * tested: the set must be complete from its FIRST read, because `registry.ts`
 * and four guards in `routes/adapters.ts` consult it synchronously.
 */

const originalManagedConfig = process.env[MANAGED_CONFIG_ENV_KEY];

function managedConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    mode: "cloud",
    catalogVersion: "2026.720.0",
    features: {},
    plugins: { autoInstall: [] },
    ...overrides,
  });
}

async function importFresh(raw: string | undefined) {
  vi.resetModules();
  if (raw === undefined) delete process.env[MANAGED_CONFIG_ENV_KEY];
  else process.env[MANAGED_CONFIG_ENV_KEY] = raw;
  return import("./builtin-adapter-types.js");
}

afterEach(() => {
  if (originalManagedConfig === undefined) delete process.env[MANAGED_CONFIG_ENV_KEY];
  else process.env[MANAGED_CONFIG_ENV_KEY] = originalManagedConfig;
  vi.resetModules();
});

describe("BUILTIN_ADAPTER_TYPES", () => {
  it("is exactly the core set when nothing is configured (self-hosted)", async () => {
    const mod = await importFresh(undefined);
    expect([...mod.BUILTIN_ADAPTER_TYPES].sort()).toEqual(
      [...mod.CORE_BUILTIN_ADAPTER_TYPES].sort(),
    );
    expect(() => mod.assertConfiguredBuiltinAdapterTypesValid()).not.toThrow();
  });

  it("includes a configured type from the first read", async () => {
    const mod = await importFresh(
      managedConfig({
        adapters: { builtin: [{ type: "my_adapter", relativePath: "my-adapter" }] },
      }),
    );
    expect(mod.BUILTIN_ADAPTER_TYPES.has("my_adapter")).toBe(true);
    expect(mod.CORE_BUILTIN_ADAPTER_TYPES.has("my_adapter")).toBe(false);
    // Core types are never dropped by the composition.
    for (const type of mod.CORE_BUILTIN_ADAPTER_TYPES) {
      expect(mod.BUILTIN_ADAPTER_TYPES.has(type)).toBe(true);
    }
  });

  it("captures a malformed document instead of throwing at import", async () => {
    // Throwing at import time would bypass the fail-closed log path that
    // index.ts owns for a malformed document.
    const mod = await importFresh("{not json");
    expect([...mod.BUILTIN_ADAPTER_TYPES].sort()).toEqual(
      [...mod.CORE_BUILTIN_ADAPTER_TYPES].sort(),
    );
    expect(() => mod.assertConfiguredBuiltinAdapterTypesValid()).toThrow(/not valid JSON/);
  });
});

describe("configured built-in adapter protection", () => {
  it("refuses to unregister a configured type, exactly like a compiled-in one", async () => {
    vi.resetModules();
    process.env[MANAGED_CONFIG_ENV_KEY] = managedConfig({
      adapters: { builtin: [{ type: "my_adapter", relativePath: "my-adapter" }] },
    });
    const registry = await import("./registry.js");

    // Stand in for the adapter the image would have shipped. The module load
    // itself fails here (no package on disk), which is the point: the TYPE is
    // protected from module init, independently of whether the code loaded.
    registry.registerServerAdapter({
      type: "my_adapter",
      async execute() {
        return { exitCode: 0, signal: null, timedOut: false };
      },
      async testEnvironment() {
        return { adapterType: "my_adapter", status: "pass", testedAt: "", checks: [] };
      },
    });
    expect(registry.findServerAdapter("my_adapter")).not.toBeNull();

    // A plugin uninstall must not be able to delete a protected type.
    registry.unregisterServerAdapter("my_adapter");
    expect(registry.findServerAdapter("my_adapter")).not.toBeNull();

    // A type that is neither core nor configured stays removable.
    registry.registerServerAdapter({
      type: "plain_external",
      async execute() {
        return { exitCode: 0, signal: null, timedOut: false };
      },
      async testEnvironment() {
        return { adapterType: "plain_external", status: "pass", testedAt: "", checks: [] };
      },
    });
    registry.unregisterServerAdapter("plain_external");
    expect(registry.findServerAdapter("plain_external")).toBeNull();
  });

  it("surfaces a load failure through the startup gate rather than an unhandled rejection", async () => {
    vi.resetModules();
    process.env[MANAGED_CONFIG_ENV_KEY] = managedConfig({
      adapters: { builtin: [{ type: "my_adapter", relativePath: "my-adapter" }] },
    });
    const registry = await import("./registry.js");
    // No such package in the image, so resolution refuses to start — and the
    // refusal arrives at an awaited point, not as a rejected floating promise.
    await expect(registry.assertConfiguredBuiltinAdaptersLoaded()).rejects.toThrow(
      /no package is there/,
    );
  });
});
