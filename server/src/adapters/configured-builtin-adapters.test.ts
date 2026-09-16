import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultBuiltinAdapterRoot,
  loadConfiguredBuiltinAdapters,
  resolveConfiguredBuiltinAdapters,
} from "./configured-builtin-adapters.js";
import { CORE_BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const SPEC = { type: "my_adapter", relativePath: "my-adapter" };

const VALID_DECLARATION = {
  type: SPEC.type,
  displayName: "My Adapter",
  description: "An adapter shipped in this image",
  icon: "cpu",
};

/** Lay down an adapter package, optionally with a `paperclip.adapter` block. */
function writePackage(
  root: string,
  relativePath: string,
  options: {
    declaration?: Record<string, unknown> | null;
    name?: string;
    exports?: unknown;
    malformed?: boolean;
    entry?: { file: string; source: string };
  } = {},
): string {
  const dir = path.join(root, relativePath);
  mkdirSync(dir, { recursive: true });
  if (options.malformed) {
    writeFileSync(path.join(dir, "package.json"), "{not json");
    return dir;
  }
  const declaration = options.declaration === undefined ? VALID_DECLARATION : options.declaration;
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: options.name ?? "@acme/my-adapter",
      type: "module",
      ...(options.exports !== undefined ? { exports: options.exports } : {}),
      ...(declaration ? { paperclip: { adapter: declaration } } : {}),
    }),
  );
  if (options.entry) {
    writeFileSync(path.join(dir, options.entry.file), options.entry.source);
  }
  return dir;
}

function resolveOne(root: string, spec = SPEC) {
  return resolveConfiguredBuiltinAdapters([spec], {
    adapterRoot: root,
    coreTypes: CORE_BUILTIN_ADAPTER_TYPES,
  });
}

// ---------------------------------------------------------------------------
// Root derivation
// ---------------------------------------------------------------------------

describe("defaultBuiltinAdapterRoot", () => {
  it("derives the root from this module's own location, with no env override", () => {
    const root = defaultBuiltinAdapterRoot();
    expect(root.endsWith(path.join("packages", "adapters"))).toBe(true);
    expect(path.isAbsolute(root)).toBe(true);
    // The whole point of deriving rather than reading an env var: a hostile
    // environment cannot move the root and then elect a child of it.
    process.env.PAPERCLIP_BUILTIN_ADAPTER_ROOT = "/tmp/evil";
    process.env.PAPERCLIP_BUNDLED_PLUGIN_ROOT = "/tmp/evil";
    try {
      expect(defaultBuiltinAdapterRoot()).toBe(root);
    } finally {
      delete process.env.PAPERCLIP_BUILTIN_ADAPTER_ROOT;
      delete process.env.PAPERCLIP_BUNDLED_PLUGIN_ROOT;
    }
  });
});

// ---------------------------------------------------------------------------
// Resolution (fail-to-start allowlist)
// ---------------------------------------------------------------------------

describe("resolveConfiguredBuiltinAdapters", () => {
  it("resolves nothing when nothing is declared", () => {
    expect(
      resolveConfiguredBuiltinAdapters([], {
        adapterRoot: "/app/packages/adapters",
        coreTypes: CORE_BUILTIN_ADAPTER_TYPES,
      }),
    ).toEqual([]);
  });

  it("resolves a declared package and harvests its display metadata", () => {
    const root = makeTempDir("adapters-root-");
    const dir = writePackage(root, SPEC.relativePath);
    expect(resolveOne(root)).toEqual([
      {
        type: "my_adapter",
        // Canonical, not as written: the directory that was checked for
        // containment is the directory that gets read and imported.
        packageDir: realpathSync(dir),
        packageName: "@acme/my-adapter",
        entrySubpath: ".",
        displayName: "My Adapter",
        description: "An adapter shipped in this image",
        iconName: "cpu",
      },
    ]);
  });

  it("defaults the entry subpath to the package root and honors a declared one", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, {
      declaration: { ...VALID_DECLARATION, entry: "./server" },
    });
    expect(resolveOne(root)[0]!.entrySubpath).toBe("./server");
  });

  // This is the property that keeps builtin-override protection meaningful:
  // a configured type joins BUILTIN_ADAPTER_TYPES, so allowing a core type
  // here would let a document displace a shipped adapter.
  it("refuses a type compiled into this build (fail to start)", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, "claude-local", { declaration: { type: "claude_local" } });
    expect(() =>
      resolveOne(root, { type: "claude_local", relativePath: "claude-local" }),
    ).toThrow(/"claude_local" is compiled into this build and cannot be redeclared/);
  });

  it("refuses a duplicate type within the document", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath);
    expect(() =>
      resolveConfiguredBuiltinAdapters([SPEC, SPEC], {
        adapterRoot: root,
        coreTypes: CORE_BUILTIN_ADAPTER_TYPES,
      }),
    ).toThrow(/declared more than once/);
  });

  it("refuses a path that escapes the adapter root", () => {
    const root = makeTempDir("adapters-root-");
    expect(() => resolveOne(root, { type: "my_adapter", relativePath: "../evil" })).toThrow(
      /outside the built-in adapter root/,
    );
  });

  // The case a lexical spelling rule cannot see, which is why containment
  // canonicalizes rather than only normalizing.
  it("refuses a symlink inside the root that points out of it", () => {
    const outside = makeTempDir("adapters-outside-");
    writeFileSync(
      path.join(outside, "package.json"),
      JSON.stringify({ name: "@acme/my-adapter", paperclip: { adapter: VALID_DECLARATION } }),
    );
    const root = makeTempDir("adapters-root-");
    symlinkSync(outside, path.join(root, SPEC.relativePath));
    expect(() => resolveOne(root)).toThrow(/outside the built-in adapter root/);
  });

  it("refuses the adapter root itself", () => {
    const root = makeTempDir("adapters-root-");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@acme/root", paperclip: { adapter: VALID_DECLARATION } }),
    );
    expect(() => resolveOne(root, { type: "my_adapter", relativePath: "." })).toThrow(
      /outside the built-in adapter root/,
    );
  });

  // Deliberately unlike a missing bundled plugin, which skips: an unknown
  // adapter type falls back to the process adapter, so a missing adapter would
  // dispatch every one of its agents to the wrong executor, silently.
  it("refuses to start when the declared package is absent", () => {
    const root = makeTempDir("adapters-root-");
    expect(() => resolveOne(root)).toThrow(
      /is declared at .* but no package is there.*refuses to start/s,
    );
  });

  it("refuses a package that does not declare paperclip.adapter", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, { declaration: null });
    expect(() => resolveOne(root)).toThrow(
      /does not declare paperclip.adapter.*must opt in.*refusing to start/,
    );
  });

  it("refuses a package that declares a different type (no re-badging)", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, {
      declaration: { ...VALID_DECLARATION, type: "someone_elses_adapter" },
    });
    expect(() => resolveOne(root)).toThrow(
      /declares type "someone_elses_adapter".*cannot be elected under a type it does not declare/,
    );
  });

  it("refuses a package with an unreadable package.json", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, { malformed: true });
    expect(() => resolveOne(root)).toThrow(/has no readable package.json.*refusing to start/);
  });

  it("refuses a non-string display field", () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, {
      declaration: { type: SPEC.type, displayName: 42 },
    });
    expect(() => resolveOne(root)).toThrow(/non-string paperclip.adapter.displayName/);
  });
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("loadConfiguredBuiltinAdapters", () => {
  const adapterSource = (type: string) => `
export function createServerAdapter() {
  return {
    type: ${JSON.stringify(type)},
    async execute() { return { exitCode: 0, signal: null, timedOut: false }; },
    async testEnvironment() { return { adapterType: ${JSON.stringify(type)}, status: "pass", testedAt: "", checks: [] }; },
  };
}
`;

  it("loads a declared package and overlays its display metadata", async () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, {
      exports: { ".": "./index.js" },
      entry: { file: "index.js", source: adapterSource(SPEC.type) },
    });
    const [adapter] = await loadConfiguredBuiltinAdapters(resolveOne(root));
    expect(adapter!.type).toBe("my_adapter");
    expect(adapter!.displayName).toBe("My Adapter");
    expect(adapter!.description).toBe("An adapter shipped in this image");
    expect(adapter!.iconName).toBe("cpu");
  });

  // The manifest and the module are two different claims. Registration keys
  // off the runtime value, so only checking the manifest would leave a way
  // past the core-shadowing refusal.
  it("refuses a module whose returned type disagrees with its declaration", async () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, {
      exports: { ".": "./index.js" },
      entry: { file: "index.js", source: adapterSource("claude_local") },
    });
    await expect(loadConfiguredBuiltinAdapters(resolveOne(root))).rejects.toThrow(
      /returned type "claude_local", expected "my_adapter"; refusing to start/,
    );
  });

  it("refuses an entry point that escapes the package directory", async () => {
    const root = makeTempDir("adapters-root-");
    writeFileSync(path.join(root, "evil.js"), adapterSource(SPEC.type));
    writePackage(root, SPEC.relativePath, { exports: { ".": "../evil.js" } });
    await expect(loadConfiguredBuiltinAdapters(resolveOne(root))).rejects.toThrow(
      /escapes its package directory; refusing to load/,
    );
  });

  it("refuses a package that exports no createServerAdapter", async () => {
    const root = makeTempDir("adapters-root-");
    writePackage(root, SPEC.relativePath, {
      exports: { ".": "./index.js" },
      entry: { file: "index.js", source: "export const nothing = 1;\n" },
    });
    await expect(loadConfiguredBuiltinAdapters(resolveOne(root))).rejects.toThrow(
      /does not export createServerAdapter/,
    );
  });
});
