import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildBundledPluginCatalog,
  resolveBundledPluginInstalls,
} from "../services/bundled-plugins.js";
import { parseManagedConfigEnv, MANAGED_CONFIG_ENV_KEY } from "../services/managed-config.js";
import {
  loadConfiguredBuiltinAdapters,
  resolveConfiguredBuiltinAdapters,
} from "../adapters/configured-builtin-adapters.js";
import { CORE_BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

/**
 * End-to-end contract for a distributor shipping its own extensions.
 *
 * The question this answers is the one an integrator actually asks: can an
 * adapter and a bundled plugin that live in my image be registered entirely
 * through configuration, with no edit to any source file here? The unit tests
 * cover each rule; this covers the whole path a real document takes, so the
 * answer cannot drift as the pieces are refactored separately.
 */

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The image layout a distributor's build produces. */
function buildImage(): { adapterRoot: string; catalogRoot: string } {
  const root = makeTempDir("image-");

  // packages/adapters/acme-adapter — an execution adapter, grafted as a
  // workspace package and declaring itself loadable as a built-in.
  const adapterRoot = path.join(root, "packages", "adapters");
  const adapterDir = path.join(adapterRoot, "acme-adapter");
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(
    path.join(adapterDir, "package.json"),
    JSON.stringify({
      name: "@acme/paperclip-adapter",
      type: "module",
      exports: { ".": "./index.js" },
      paperclip: {
        adapter: {
          type: "acme_remote",
          displayName: "Acme (remote)",
          description: "Runs work on an Acme worker",
          icon: "cpu",
        },
      },
    }),
  );
  writeFileSync(
    path.join(adapterDir, "index.js"),
    `export function createServerAdapter() {
  return {
    type: "acme_remote",
    async execute() { return { exitCode: 0, signal: null, timedOut: false }; },
    async testEnvironment() { return { adapterType: "acme_remote", status: "pass", testedAt: "", checks: [] }; },
    getConfigSchema: () => ({ fields: [{ key: "endpoint", label: "Endpoint", type: "text" }] }),
  };
}
`,
  );

  // packages/plugins/acme/operations — a bundled plugin, grafted under its
  // own subtree and declaring the key it may be elected under.
  const catalogRoot = path.join(root, "packages", "plugins");
  const pluginDir = path.join(catalogRoot, "acme", "operations");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@acme/operations",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
        worker: "./dist/worker.js",
        bundledKey: "acme-operations",
        bundledPluginKey: "acme.operations",
      },
    }),
  );

  return { adapterRoot, catalogRoot };
}

/** The document the control plane delivers. Nothing else is configured. */
const DOCUMENT = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "2026.720.0",
  features: { enableManagedSandboxOnly: true },
  plugins: {
    autoInstall: ["daytona", "acme-operations"],
    catalog: [
      {
        key: "acme-operations",
        pluginKey: "acme.operations",
        relativePath: "acme/operations",
      },
    ],
  },
  adapters: {
    builtin: [{ type: "acme_remote", relativePath: "acme-adapter" }],
  },
  environments: [{ name: "Acme", provider: "daytona", config: { target: "us" } }],
});

describe("registering image-shipped extensions entirely through configuration", () => {
  it("registers an adapter and a bundled plugin with no source edit", async () => {
    const { adapterRoot, catalogRoot } = buildImage();
    const config = parseManagedConfigEnv({ [MANAGED_CONFIG_ENV_KEY]: DOCUMENT });
    expect(config).not.toBeNull();

    // --- Adapter half -----------------------------------------------------
    const resolvedAdapters = resolveConfiguredBuiltinAdapters(config!.adapters.builtin, {
      adapterRoot,
      coreTypes: CORE_BUILTIN_ADAPTER_TYPES,
    });
    const [adapter] = await loadConfiguredBuiltinAdapters(resolvedAdapters);
    expect(adapter!.type).toBe("acme_remote");
    // Display metadata reaches the adapter listing, so the picker shows a real
    // name rather than a humanized type id.
    expect(adapter!.displayName).toBe("Acme (remote)");
    expect(adapter!.description).toBe("Runs work on an Acme worker");
    expect(adapter!.iconName).toBe("cpu");
    // Config is schema-driven, so no per-adapter form component is needed.
    expect(adapter!.getConfigSchema?.({})).toEqual({
      fields: [{ key: "endpoint", label: "Endpoint", type: "text" }],
    });

    // --- Plugin half ------------------------------------------------------
    const catalog = buildBundledPluginCatalog(config!.plugins.catalog);
    const installs = resolveBundledPluginInstalls(config!.plugins.autoInstall, {
      catalog,
      catalogRoot,
      env: {},
      enforceCatalogRoot: true,
    });
    expect(installs).toEqual([
      {
        key: "daytona",
        pluginKey: "paperclip.daytona-sandbox-provider",
        localPath: path.join(catalogRoot, "sandbox-providers/daytona"),
      },
      {
        key: "acme-operations",
        pluginKey: "acme.operations",
        localPath: path.join(catalogRoot, "acme/operations"),
      },
    ]);
  });

  it("refuses the same document against an image that ships neither extension", () => {
    const emptyImage = makeTempDir("empty-image-");
    const config = parseManagedConfigEnv({ [MANAGED_CONFIG_ENV_KEY]: DOCUMENT });

    // The adapter refuses to start: a missing adapter would be silently
    // dispatched to the process adapter.
    expect(() =>
      resolveConfiguredBuiltinAdapters(config!.adapters.builtin, {
        adapterRoot: emptyImage,
        coreTypes: CORE_BUILTIN_ADAPTER_TYPES,
      }),
    ).toThrow(/no package is there/);

    // The plugin does NOT: a missing bundle degrades to one unavailable
    // provider, which the installer logs and skips.
    expect(() =>
      resolveBundledPluginInstalls(config!.plugins.autoInstall, {
        catalog: buildBundledPluginCatalog(config!.plugins.catalog),
        catalogRoot: emptyImage,
        env: {},
        enforceCatalogRoot: true,
      }),
    ).not.toThrow();
  });
});
