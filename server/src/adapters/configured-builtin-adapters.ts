/**
 * Built-in adapters declared by configuration.
 *
 * A distributor that ships an execution adapter in its own release image had
 * no way to register it as a built-in: `registerBuiltInAdapters()` and
 * `BUILTIN_ADAPTER_TYPES` are compiled in, so adding one meant patching core.
 * Installing it as an adapter *plugin* is not the same thing — built-in types
 * are protected from plugin override, which is precisely the property such a
 * distributor wants for the adapter its fleet runs on.
 *
 * `adapters.builtin` in `PAPERCLIP_MANAGED_CONFIG` elects a package under the
 * built-in adapter root, and it is deliberately shaped like the bundled-plugin
 * catalog (see `services/bundled-plugins.ts`): a positive allowlist, not a
 * lookup, resolved synchronously before the server listens.
 *
 * WHAT A DOCUMENT CAN REACH. Exactly the set of packages the image author both
 * (a) shipped under the adapter root and (b) marked loadable with a
 * `paperclip.adapter` declaration. That is the same *class* of authority the
 * compiled-in registry grants; the membership of the set is still fixed by
 * whoever builds the image, never by whoever writes the document. In
 * particular a document cannot:
 *
 * - **Name a path outside the root.** Two independent barriers: a lexical rule
 *   at parse time (no `..`, no absolute, no `~`, no backslash, no dotfiles),
 *   then canonicalizing containment here, which resolves symlinks.
 * - **Relocate the root.** `defaultBuiltinAdapterRoot()` is derived from this
 *   module's own location with NO environment override — strictly tighter than
 *   the bundled-plugin root, which `PAPERCLIP_BUNDLED_PLUGIN_ROOT` can move.
 *   Mirroring that env var here would be the one genuine widening available in
 *   this design (hostile env points the root at a writable directory, document
 *   names a child), so it is deliberately absent. Tests inject through the
 *   resolver's `adapterRoot` option, which no runtime path supplies.
 * - **Load code that did not opt in.** Every other package under the root is
 *   inert without a `paperclip.adapter` block. Containment alone was not
 *   enough: a root full of adapter packages is exactly a root full of
 *   attractive targets.
 * - **Re-badge a package.** The declared `type` must equal the elected `type`,
 *   and the type the loaded module actually returns is checked again after
 *   import — the registry keys off the runtime value, so checking only the
 *   manifest would leave a way past the rule below.
 * - **Shadow a compiled-in adapter.** A core type is refused outright, so
 *   upstream's builtin-override protection is never reachable through
 *   configuration.
 *
 * ABSENCE IS FATAL HERE, unlike a missing bundled plugin, and the asymmetry is
 * deliberate. A missing plugin degrades visibly to "one provider unavailable".
 * A missing adapter does not degrade visibly at all: `getServerAdapter()`
 * falls back to the process adapter for an unknown type, so every agent on the
 * missing adapter would be dispatched to the wrong executor and would appear
 * to run. A refused boot is strictly better than a silent wrong executor.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, isInsideRoot } from "../services/path-containment.js";
import { loadExternalAdapterPackage } from "./plugin-loader.js";
import type { ServerAdapterModule } from "./types.js";

/** `package.json` key an adapter package uses to declare itself loadable. */
export const ADAPTER_DECLARATION_KEY = "paperclip";

/**
 * Root the release image keeps built-in adapter packages under, a sibling of
 * the bundled-plugin catalog root.
 *
 * Derived from this module's own compiled location, with no environment
 * override: unlike the bundled-plugin catalog root there is no second consumer
 * to keep in step with, so the root stays a constant of the image and a
 * compromised environment cannot move it.
 *
 * `server/{src,dist}/adapters/` is three levels below the application root in
 * both the dev tree and the built image, the same derivation
 * `services/plugin-loader.ts` uses for `REPO_ROOT`.
 */
export function defaultBuiltinAdapterRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..", "packages", "adapters");
}

/** One entry of `adapters.builtin`, already validated for shape at parse time. */
export interface ConfiguredBuiltinAdapterSpec {
  type: string;
  relativePath: string;
}

export interface ResolvedConfiguredBuiltinAdapter {
  type: string;
  /** Canonical package directory, already proven inside the adapter root. */
  packageDir: string;
  packageName: string;
  /** Subpath export to import; defaults to the package root ("."). */
  entrySubpath: string;
  displayName?: string;
  description?: string;
  iconName?: string;
}

function readDeclaredString(
  declaration: Record<string, unknown>,
  field: string,
  type: string,
): string | undefined {
  const value = declaration[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `built-in adapter "${type}" declares a non-string ${ADAPTER_DECLARATION_KEY}.adapter.${field}; refusing to start`,
    );
  }
  return value;
}

/**
 * Resolve declared built-in adapters to concrete package directories.
 *
 * SYNCHRONOUS and imports nothing: every check below is data validation, so a
 * bad document is rejected before any of its code can run. Throws — and the
 * instance must refuse to start — on a path escape, a missing directory, an
 * unreadable `package.json`, a missing or mismatched `paperclip.adapter`
 * declaration, or a type that shadows a compiled-in adapter.
 */
export function resolveConfiguredBuiltinAdapters(
  specs: readonly ConfiguredBuiltinAdapterSpec[],
  opts: { adapterRoot: string; coreTypes: ReadonlySet<string> },
): ResolvedConfiguredBuiltinAdapter[] {
  if (specs.length === 0) return [];
  const resolved: ResolvedConfiguredBuiltinAdapter[] = [];
  const canonicalRoot = canonicalize(opts.adapterRoot);
  for (const spec of specs) {
    // This is the check that keeps builtin-override protection meaningful: a
    // configured type joins BUILTIN_ADAPTER_TYPES, so allowing one to name a
    // compiled-in type would let configuration displace a shipped adapter.
    if (opts.coreTypes.has(spec.type)) {
      throw new Error(
        `built-in adapter "${spec.type}" is compiled into this build and cannot be redeclared by configuration; refusing to start`,
      );
    }
    if (resolved.some((entry) => entry.type === spec.type)) {
      throw new Error(`built-in adapter "${spec.type}" is declared more than once; refusing to start`);
    }

    const localPath = path.resolve(opts.adapterRoot, spec.relativePath);
    // Canonicalize BEFORE any read, so the directory that was checked and the
    // directory that is read are the same one even when a link is involved.
    const packageDir = canonicalize(localPath);
    if (!isInsideRoot(packageDir, canonicalRoot) || packageDir === canonicalRoot) {
      throw new Error(
        `built-in adapter "${spec.type}" resolves to "${localPath}", outside the built-in adapter root "${opts.adapterRoot}"; refusing to start`,
      );
    }
    if (!fs.existsSync(packageDir)) {
      throw new Error(
        `built-in adapter "${spec.type}" is declared at "${localPath}" but no package is there; an adapter missing from the image would be silently dispatched to the process adapter, so this refuses to start`,
      );
    }

    let pkg: unknown;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
    } catch (err) {
      throw new Error(
        `built-in adapter "${spec.type}" at "${packageDir}" has no readable package.json (${err instanceof Error ? err.message : String(err)}); refusing to start`,
      );
    }
    const manifest = (typeof pkg === "object" && pkg !== null ? pkg : {}) as Record<string, unknown>;
    const namespace = manifest[ADAPTER_DECLARATION_KEY];
    const declaration =
      typeof namespace === "object" && namespace !== null && !Array.isArray(namespace)
        ? (namespace as Record<string, unknown>).adapter
        : undefined;
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
      throw new Error(
        `built-in adapter "${spec.type}" at "${packageDir}" does not declare ${ADAPTER_DECLARATION_KEY}.adapter; a package must opt in to being loaded as a built-in adapter; refusing to start`,
      );
    }
    const declared = declaration as Record<string, unknown>;
    if (declared.type !== spec.type) {
      throw new Error(
        `built-in adapter "${spec.type}" at "${packageDir}" declares type ${JSON.stringify(declared.type ?? null)}; a package cannot be elected under a type it does not declare; refusing to start`,
      );
    }
    const packageName = typeof manifest.name === "string" && manifest.name.length > 0
      ? manifest.name
      : spec.relativePath;
    const entrySubpath = readDeclaredString(declared, "entry", spec.type) ?? ".";

    resolved.push({
      type: spec.type,
      packageDir,
      packageName,
      entrySubpath,
      displayName: readDeclaredString(declared, "displayName", spec.type),
      description: readDeclaredString(declared, "description", spec.type),
      iconName: readDeclaredString(declared, "icon", spec.type),
    });
  }
  return resolved;
}

/**
 * Import each resolved package through the same loader external adapters use,
 * so a configured built-in gets the identical treatment: entry point resolved
 * through `exports`/`main` under package containment, `createServerAdapter()`
 * required, login capability validated fail-closed, and any `./ui-parser`
 * export cached for the existing `/api/adapters/:type/ui-parser.js` route.
 *
 * The one addition is the post-import type check. Registration keys off the
 * runtime value, so without it a package could declare one type in its
 * manifest and return another, walking past the core-shadowing refusal that
 * only reads the manifest.
 */
export async function loadConfiguredBuiltinAdapters(
  resolved: readonly ResolvedConfiguredBuiltinAdapter[],
): Promise<ServerAdapterModule[]> {
  const loaded: ServerAdapterModule[] = [];
  for (const entry of resolved) {
    const adapter = await loadExternalAdapterPackage(
      entry.packageName,
      entry.packageDir,
      entry.entrySubpath,
    );
    if (adapter.type !== entry.type) {
      throw new Error(
        `built-in adapter package "${entry.packageName}" returned type "${adapter.type}", expected "${entry.type}"; refusing to start`,
      );
    }
    loaded.push({
      ...adapter,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.iconName !== undefined ? { iconName: entry.iconName } : {}),
    });
  }
  return loaded;
}
