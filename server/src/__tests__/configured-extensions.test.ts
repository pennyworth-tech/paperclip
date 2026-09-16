import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildBundledPluginCatalog,
  resolveBundledPluginInstalls,
} from "../services/bundled-plugins.js";
import { parseManagedConfigEnv, MANAGED_CONFIG_ENV_KEY } from "../services/managed-config.js";

/**
 * End-to-end contract for a distributor shipping its own bundled plugins.
 *
 * The question this answers is the one an integrator actually asks: can a
 * plugin that lives in my image be installed entirely through configuration,
 * with no edit to any source file here? The unit tests cover each rule; this
 * covers the whole path a real document takes, so the answer cannot drift as
 * the pieces are refactored separately.
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
function buildImage(): { catalogRoot: string } {
  const root = makeTempDir("image-");

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

  return { catalogRoot };
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
  environments: [{ name: "Acme", provider: "daytona", config: { target: "us" } }],
});

describe("registering image-shipped extensions entirely through configuration", () => {
  it("installs a bundled plugin with no source edit", () => {
    const { catalogRoot } = buildImage();
    const config = parseManagedConfigEnv({ [MANAGED_CONFIG_ENV_KEY]: DOCUMENT });
    expect(config).not.toBeNull();

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

  it("skips a bundled plugin the image does not ship", () => {
    const emptyImage = makeTempDir("empty-image-");
    const config = parseManagedConfigEnv({ [MANAGED_CONFIG_ENV_KEY]: DOCUMENT });

    // A missing bundle degrades to one unavailable provider, which the
    // installer logs and skips.
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
