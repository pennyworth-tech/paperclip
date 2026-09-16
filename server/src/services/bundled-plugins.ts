import path from "node:path";
import fs from "node:fs";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

/**
 * Bundled plugin auto-provisioning.
 *
 * Managed-cloud instances receive a `plugins.autoInstall` key list through
 * `PAPERCLIP_MANAGED_CONFIG` (parsed fail-closed at startup — see
 * `managed-config.ts`). Each key maps to a plugin bundled into
 * the release image under the bundled catalog root. Nobody "installs" on a
 * managed instance: the control plane provisions, tenants use.
 *
 * The catalog has two halves, composed by `buildBundledPluginCatalog`:
 *
 * - `BUNDLED_PLUGIN_CATALOG`, compiled into this file, and
 * - `plugins.catalog`, declared by the same managed-config document, for
 *   bundles a distributor ships in its own image.
 *
 * The second half widens *which names are electable*; it does not widen *what
 * a name may reach*. A configured entry is held to strictly tighter rules
 * than a compiled-in one: catalog-root containment is forced on regardless of
 * the caller's flag, it can carry no `pathOverrideEnvVar`, and the bundle it
 * names must opt in through its own `package.json` (`paperclipPlugin.bundledKey`
 * / `.bundledPluginKey`). So a document can elect only what the image author
 * both shipped under the catalog root and marked as electable — the same
 * class of authority the compiled-in half grants, with membership still set
 * by whoever builds the image.
 *
 * Two distinct failure postures, deliberately split:
 *
 * 1. **Resolution (this file, `resolveBundledPluginInstalls`) fails to
 *    start.** An unknown key or a path that escapes the bundled catalog
 *    root is a configuration/security violation — a positive allowlist,
 *    not a lookup. Throwing here happens
 *    synchronously inside `createApp`, before the server listens, so a bad
 *    document refuses to start rather than silently widening what code can
 *    be loaded into the host.
 *
 * 2. **Installation (`ensureBundledPlugins`) is fail-safe.**
 *    Missing bundle on disk, install error, load error: caught, logged,
 *    and swallowed per entry so the server ALWAYS finishes booting. A
 *    degraded boot (one provider unavailable) is strictly preferable to a
 *    crash loop across a fleet.
 *
 * Removal of a key from `autoInstall` stops future installs but never
 * auto-uninstalls: there is intentionally no uninstall
 * path anywhere in this module.
 */

/** Default location of the bundled plugin catalog inside the release image. */
export const DEFAULT_BUNDLED_CATALOG_ROOT = "/app/packages/plugins";

/**
 * Env var that relocates the bundled catalog root (dev images, tests).
 */
export const BUNDLED_CATALOG_ROOT_ENV_VAR = "PAPERCLIP_BUNDLED_PLUGIN_ROOT";

export interface BundledPluginCatalogEntry {
  /** Key the managed config's `plugins.autoInstall` list uses. */
  key: string;
  /** Manifest id / registry `pluginKey` the bundle installs as. */
  pluginKey: string;
  /** Bundle location relative to the bundled catalog root. */
  relativePath: string;
  /**
   * Legacy absolute-path override honored for compatibility (the kubernetes
   * bundle predates the catalog). Overrides are still subject to catalog
   * containment when enforcement is on.
   */
  pathOverrideEnvVar?: string;
}

/**
 * The positive allowlist of plugins the control plane may auto-provision.
 * Keys outside this table can never be installed through this path,
 * regardless of what the managed config document says.
 */
export const BUNDLED_PLUGIN_CATALOG: readonly BundledPluginCatalogEntry[] = [
  {
    key: "cloudflare",
    pluginKey: "paperclip.cloudflare-sandbox-provider",
    relativePath: "sandbox-providers/cloudflare",
  },
  {
    key: "daytona",
    pluginKey: "paperclip.daytona-sandbox-provider",
    relativePath: "sandbox-providers/daytona",
  },
  {
    key: "e2b",
    pluginKey: "paperclip.e2b-sandbox-provider",
    relativePath: "sandbox-providers/e2b",
  },
  {
    key: "exe-dev",
    pluginKey: "paperclip.exe-dev-sandbox-provider",
    relativePath: "sandbox-providers/exe-dev",
  },
  {
    key: "kubernetes",
    pluginKey: "paperclip.kubernetes-sandbox-provider",
    relativePath: "sandbox-providers/kubernetes",
    pathOverrideEnvVar: "PAPERCLIP_KUBERNETES_PLUGIN_PATH",
  },
  {
    key: "modal",
    pluginKey: "paperclip.modal-sandbox-provider",
    relativePath: "sandbox-providers/modal",
  },
  {
    key: "novita",
    pluginKey: "paperclip.novita-sandbox-provider",
    relativePath: "sandbox-providers/novita",
  },
];

/**
 * Keys ensured on a self-hosted instance (no managed config present).
 * Exactly the pre-refactor behavior: the kubernetes sandbox provider is
 * auto-installed when its bundle is present, nothing else.
 */
export const SELF_HOSTED_AUTO_INSTALL_KEYS: readonly string[] = ["kubernetes"];

/**
 * A catalog entry contributed by `plugins.catalog` rather than compiled in.
 * Deliberately NOT a `BundledPluginCatalogEntry`: it has no
 * `pathOverrideEnvVar`, so no document can introduce a new environment
 * variable that relocates a bundle.
 */
export interface ConfiguredBundledPluginCatalogEntry {
  key: string;
  pluginKey: string;
  relativePath: string;
}

/** A catalog entry after composition, tagged with where it came from. */
export type ComposedBundledPluginCatalogEntry = BundledPluginCatalogEntry & {
  /** Present only on entries a managed-config document contributed. */
  readonly configured?: true;
};

/**
 * `package.json` key a bundled plugin uses to declare itself. Every bundle in
 * the compiled-in catalog already carries it; a configured entry additionally
 * requires `bundledKey` and `bundledPluginKey` inside it to match the entry
 * that elected it.
 */
const PLUGIN_DECLARATION_KEY = "paperclipPlugin";

/**
 * Compose the compiled-in catalog with control-plane-declared additions.
 *
 * Additions may only ADD. A `key` or `pluginKey` colliding with a compiled-in
 * entry throws, so configuration can never redirect a name this build ships
 * — the property that keeps the compiled-in half a fixed point no document
 * can move. Throwing happens synchronously inside `createApp`, before the
 * server listens, like every other resolution failure in this module.
 */
export function buildBundledPluginCatalog(
  configured: readonly ConfiguredBundledPluginCatalogEntry[],
): readonly ComposedBundledPluginCatalogEntry[] {
  if (configured.length === 0) return BUNDLED_PLUGIN_CATALOG;
  const composed: ComposedBundledPluginCatalogEntry[] = [...BUNDLED_PLUGIN_CATALOG];
  const keys = new Set(BUNDLED_PLUGIN_CATALOG.map((entry) => entry.key));
  const pluginKeys = new Set(BUNDLED_PLUGIN_CATALOG.map((entry) => entry.pluginKey));
  for (const entry of configured) {
    if (keys.has(entry.key)) {
      throw new Error(
        `configured bundled plugin key "${entry.key}" is already a compiled-in catalog key; configuration may add catalog entries but never shadow one shipped in this build; refusing to start`,
      );
    }
    if (pluginKeys.has(entry.pluginKey)) {
      throw new Error(
        `configured bundled plugin "${entry.key}" declares pluginKey "${entry.pluginKey}", which is already a compiled-in catalog pluginKey; refusing to start`,
      );
    }
    keys.add(entry.key);
    pluginKeys.add(entry.pluginKey);
    composed.push({
      key: entry.key,
      pluginKey: entry.pluginKey,
      relativePath: entry.relativePath,
      configured: true,
    });
  }
  return composed;
}

export function resolveBundledCatalogRoot(
  env: Record<string, string | undefined>,
): string {
  const override = env[BUNDLED_CATALOG_ROOT_ENV_VAR]?.trim();
  return override ? override : DEFAULT_BUNDLED_CATALOG_ROOT;
}

export interface ResolvedBundledPlugin {
  key: string;
  pluginKey: string;
  /** Absolute path handed to `loader.installPlugin({ localPath })`. */
  localPath: string;
}

/**
 * Canonicalize a path for containment comparison. Symlinks are resolved so a
 * link inside the catalog cannot point install resolution at a directory
 * outside it.
 *
 * A path that does not exist is canonicalized as far as it does: the nearest
 * existing ancestor is resolved with `realpath` and the remaining segments are
 * appended lexically. Resolving only whole paths was wrong in both directions.
 * It produced a false NEGATIVE whenever the catalog root itself sat behind a
 * symlink and an elected bundle was simply absent from the image — the root
 * canonicalized, the missing bundle path did not, and a managed instance that
 * should have logged "bundle not present; skipping" refused to boot instead.
 * And it produced a false POSITIVE for a not-yet-existing path *under* a
 * symlinked intermediate directory, which compared as inside the root while
 * resolving outside it.
 */
function canonicalize(p: string): string {
  let current = path.resolve(p);
  const trailing: string[] = [];
  // Bounded by construction: every iteration removes one segment, and
  // `path.dirname` of a root is that root, which ends the walk.
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Verify that the bundle a configured catalog entry names has opted in to
 * being loaded under that entry.
 *
 * ABSENCE IS BENIGN and returns without throwing, deliberately: the
 * unassembled dev tree and an image built without a distributor's bundle both
 * legitimately lack the directory, and `ensureBundledPlugins` already logs and
 * skips. What throws is a bundle that is PRESENT but does not declare itself,
 * or declares itself under a different key — that is not a missing file, it is
 * a document pointing at code that never agreed to be loaded this way, and it
 * is what stops any incidental directory under the catalog root (a fixture, a
 * dev bundle, an SDK) from being electable.
 *
 * The read is done through `canonicalPath`, the symlink-resolved directory
 * the containment check already accepted, so the file read and the file
 * checked are the same file.
 */
function assertConfiguredBundleDeclaration(
  entry: ComposedBundledPluginCatalogEntry,
  canonicalPath: string,
): void {
  if (!fs.existsSync(canonicalPath)) return;
  const manifestPath = path.join(canonicalPath, "package.json");
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `bundled plugin "${entry.key}" at "${canonicalPath}" has no readable package.json (${err instanceof Error ? err.message : String(err)}); refusing to start`,
    );
  }
  const declaration =
    typeof pkg === "object" && pkg !== null
      ? (pkg as Record<string, unknown>)[PLUGIN_DECLARATION_KEY]
      : undefined;
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    throw new Error(
      `bundled plugin "${entry.key}" at "${canonicalPath}" does not declare "${PLUGIN_DECLARATION_KEY}"; a package must opt in to being loaded as a bundled plugin; refusing to start`,
    );
  }
  const declared = declaration as Record<string, unknown>;
  if (declared.bundledKey !== entry.key) {
    throw new Error(
      `bundled plugin "${entry.key}" at "${canonicalPath}" declares ${PLUGIN_DECLARATION_KEY}.bundledKey ${JSON.stringify(declared.bundledKey ?? null)}; a package must be elected under the key it declares; refusing to start`,
    );
  }
  if (declared.bundledPluginKey !== entry.pluginKey) {
    throw new Error(
      `bundled plugin "${entry.key}" at "${canonicalPath}" declares ${PLUGIN_DECLARATION_KEY}.bundledPluginKey ${JSON.stringify(declared.bundledPluginKey ?? null)}, but the catalog entry installs it as "${entry.pluginKey}"; refusing to start`,
    );
  }
}

/**
 * Resolve auto-install keys to concrete bundle paths.
 *
 * Throws — and the instance must refuse to start — when a key is not in
 * the bundled catalog, or when `enforceCatalogRoot` is set and the
 * resolved path escapes the catalog root. Callers pass
 * `enforceCatalogRoot: true` for managed (control-plane-driven) key lists
 * and `false` for the self-hosted built-in list, where the legacy
 * kubernetes path override may point anywhere (unchanged behavior).
 *
 * Entries the managed-config document contributed (`configured: true`) are
 * held to tighter rules than the compiled-in ones regardless of the caller's
 * flags: containment is always enforced, no path-override environment
 * variable is consulted, and the bundle must declare itself. The legacy
 * "may point anywhere" escape belongs to the compiled-in kubernetes entry
 * alone and stays there.
 */
export function resolveBundledPluginInstalls(
  keys: readonly string[],
  opts: {
    catalogRoot: string;
    env: Record<string, string | undefined>;
    enforceCatalogRoot: boolean;
    /**
     * Catalog to resolve against. Defaults to the compiled-in catalog, so
     * every caller that does not compose one behaves exactly as before.
     */
    catalog?: readonly ComposedBundledPluginCatalogEntry[];
  },
): ResolvedBundledPlugin[] {
  const catalog: readonly ComposedBundledPluginCatalogEntry[] =
    opts.catalog ?? BUNDLED_PLUGIN_CATALOG;
  const resolved: ResolvedBundledPlugin[] = [];
  const seen = new Set<string>();
  const canonicalRoot = canonicalize(opts.catalogRoot);
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = catalog.find((candidate) => candidate.key === key);
    if (!entry) {
      const known = catalog.map((candidate) => candidate.key).join(", ");
      throw new Error(
        `bundled plugin auto-install key "${key}" is not in the bundled catalog (known keys: ${known}); refusing to start`,
      );
    }
    const override = !entry.configured && entry.pathOverrideEnvVar
      ? opts.env[entry.pathOverrideEnvVar]?.trim()
      : undefined;
    const localPath = override
      ? path.resolve(override)
      : path.resolve(opts.catalogRoot, entry.relativePath);
    const canonicalPath = canonicalize(localPath);
    if ((opts.enforceCatalogRoot || entry.configured) && !isInsideRoot(canonicalPath, canonicalRoot)) {
      throw new Error(
        `bundled plugin "${key}" resolves to "${localPath}", outside the bundled catalog root "${opts.catalogRoot}"; refusing to start`,
      );
    }
    if (entry.configured) {
      assertConfiguredBundleDeclaration(entry, canonicalPath);
    }
    resolved.push({ key: entry.key, pluginKey: entry.pluginKey, localPath });
  }
  return resolved;
}

interface RegistryPluginRow {
  id: string;
  pluginKey: string;
  status: string;
  version: string;
  manifestJson: PaperclipPluginManifestV1;
}

export interface BundledPluginProvisionerDeps {
  registry: {
    getByKey(pluginKey: string): Promise<RegistryPluginRow | null>;
    update(
      id: string,
      data: { version?: string; manifest?: PaperclipPluginManifestV1 },
    ): Promise<unknown>;
  };
  loader: {
    installPlugin(options: { localPath: string }): Promise<{
      manifest: { id: string } | null;
    }>;
    loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null>;
  };
  lifecycle: {
    load(pluginId: string): Promise<unknown>;
  };
  logger: {
    info(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
  /** Overridable for tests; defaults to checking `dist/manifest.js`. */
  bundleManifestExists?: (localPath: string) => boolean;
}

function defaultBundleManifestExists(localPath: string): boolean {
  return fs.existsSync(path.join(localPath, "dist", "manifest.js"));
}

/**
 * Reconcile a present bundled plugin's persisted manifest with the shipped
 * bundle. The bundle is part of the release image, so its manifest is the
 * source of truth. When the bundle declares a version that differs from the
 * persisted version, update the stored manifest and version. This propagates
 * a manifest change (for example a new driver capability) to an existing
 * install that the auto-install path skips.
 *
 * The step is fail-safe. A missing bundle, a manifest read error, or a
 * database error is caught, logged, and swallowed, so boot always completes.
 * The step updates only the stored manifest row; it never restarts the worker.
 */
async function reconcileBundledPluginManifest(
  existing: RegistryPluginRow,
  install: ResolvedBundledPlugin,
  deps: BundledPluginProvisionerDeps,
  bundleManifestExists: (localPath: string) => boolean,
): Promise<void> {
  try {
    if (!bundleManifestExists(install.localPath)) return;
    const bundleManifest = await deps.loader.loadManifest(install.localPath);
    if (!bundleManifest) return;
    if (bundleManifest.version === existing.version) return;
    await deps.registry.update(existing.id, {
      version: bundleManifest.version,
      manifest: bundleManifest,
    });
    deps.logger.info(
      {
        pluginKey: install.pluginKey,
        fromVersion: existing.version,
        toVersion: bundleManifest.version,
      },
      "reconciled bundled plugin manifest to the shipped bundle version",
    );
  } catch (err) {
    deps.logger.error(
      { err, pluginKey: install.pluginKey },
      "Failed to reconcile bundled plugin manifest; continuing boot with the stored manifest",
    );
  }
}

/**
 * Ensure each resolved bundled plugin is installed and loaded.
 *
 * Same mechanism the kubernetes bundle has always used: in-process
 * `loader.installPlugin({ localPath })` at boot — no HTTP, no user, no
 * role. Fully fail-safe per entry: any disk/install/load
 * failure is caught, logged, and swallowed so boot always completes.
 *
 * Skip semantics:
 * - A plugin present in any non-uninstalled state is skipped, so an
 *   operator-disabled plugin is not silently re-enabled on reboot. Before the
 *   skip, the persisted manifest is reconciled to the shipped bundle version
 *   (see `reconcileBundledPluginManifest`).
 * - A soft-uninstalled plugin is reinstalled only when
 *   `reinstallUninstalled` is set (managed mode, where the control plane
 *   owns provisioning). Self-hosted keeps the pre-refactor behavior of
 *   leaving an operator's uninstall alone.
 */
export async function ensureBundledPlugins(
  installs: readonly ResolvedBundledPlugin[],
  deps: BundledPluginProvisionerDeps,
  opts: { reinstallUninstalled: boolean },
): Promise<void> {
  const bundleManifestExists = deps.bundleManifestExists ?? defaultBundleManifestExists;
  for (const install of installs) {
    try {
      const existing = await deps.registry.getByKey(install.pluginKey);
      if (existing && (existing.status !== "uninstalled" || !opts.reinstallUninstalled)) {
        // The bundle ships with the release image, so its manifest is the
        // source of truth for a present plugin. Reconcile the persisted
        // manifest when the shipped bundle declares a newer version. Without
        // this step a manifest capability added to a bundle never reaches an
        // existing install, because the auto-install below skips a present
        // plugin. The reconcile updates only the stored manifest row; the
        // running worker already runs the shipped code.
        await reconcileBundledPluginManifest(existing, install, deps, bundleManifestExists);
        deps.logger.info(
          { pluginKey: install.pluginKey, status: existing.status },
          "bundled plugin already present; skipping auto-install",
        );
        continue;
      }
      // Skip silently when the bundle is absent (e.g. local dev or an image
      // built without the plugin). Not an error condition.
      if (!bundleManifestExists(install.localPath)) {
        deps.logger.info(
          { pluginKey: install.pluginKey, pluginPath: install.localPath },
          "bundled plugin bundle not present; skipping auto-install",
        );
        continue;
      }
      deps.logger.info(
        { pluginKey: install.pluginKey, pluginPath: install.localPath },
        "auto-installing bundled plugin",
      );
      const discovered = await deps.loader.installPlugin({ localPath: install.localPath });
      if (!discovered.manifest) {
        deps.logger.error(
          { pluginKey: install.pluginKey },
          "bundled plugin installed but manifest is missing",
        );
        continue;
      }
      // Transition installed -> ready. Whether this also starts the worker
      // depends on the injected lifecycle manager: one built with a
      // runtime-capable loader activates here; the boot-time manager in
      // app.ts is not, so at startup this only records `ready` and the
      // worker is started exactly once by the subsequent loader.loadAll().
      const installed = await deps.registry.getByKey(discovered.manifest.id);
      if (installed) {
        await deps.lifecycle.load(installed.id);
        deps.logger.info(
          { pluginId: installed.id, pluginKey: installed.pluginKey },
          "bundled plugin auto-installed and loaded",
        );
      } else {
        deps.logger.error(
          { pluginKey: install.pluginKey },
          "bundled plugin installed but not found in registry",
        );
      }
    } catch (err) {
      deps.logger.error(
        { err, pluginKey: install.pluginKey },
        "Failed to auto-install bundled plugin; continuing boot (degraded: plugin unavailable)",
      );
    }
  }
}
