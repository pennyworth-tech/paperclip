import { describe, expect, it } from "vitest";
import {
  MANAGED_CONFIG_ENV_KEY,
  getManagedInstanceConfig,
  managedFeatureKeySet,
  parseManagedConfigEnv,
} from "../services/managed-config.js";

function envWith(raw: string | undefined) {
  return { [MANAGED_CONFIG_ENV_KEY]: raw };
}

function validDoc(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    mode: "cloud",
    catalogVersion: "2026.720.0",
    features: { enableApps: false, enablePipelines: true },
    plugins: { autoInstall: ["daytona", "kubernetes"] },
    ...overrides,
  });
}

describe("managedFeatureKeySet", () => {
  it("contains exactly the boolean flags of the experimental schema", () => {
    const keys = managedFeatureKeySet();
    expect(keys.has("enableApps")).toBe(true);
    expect(keys.has("enableWorktreeRunExecution")).toBe(true);
    // Server-managed bookkeeping fields are not overlayable features.
    expect(keys.has("worktreeRunExecutionActivatedAt")).toBe(false);
    expect(keys.has("worktreeRunExecutionActivationInstanceId")).toBe(false);
    expect(keys.has("issueGraphLivenessAutoRecoveryLookbackHours")).toBe(false);
  });
});

describe("parseManagedConfigEnv", () => {
  it("returns null when the env var is absent (self-hosted)", () => {
    expect(parseManagedConfigEnv({})).toBeNull();
    expect(parseManagedConfigEnv(envWith(undefined))).toBeNull();
  });

  it("throws when the env var is present but blank (fail closed)", () => {
    expect(() => parseManagedConfigEnv(envWith(""))).toThrow(/is set but blank/);
    expect(() => parseManagedConfigEnv(envWith("   "))).toThrow(/is set but blank/);
    expect(() => parseManagedConfigEnv(envWith("\n\t"))).toThrow(/is set but blank/);
  });

  it("parses a complete valid document", () => {
    const config = parseManagedConfigEnv(envWith(validDoc()));
    expect(config).toEqual({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: { enableApps: false, enablePipelines: true },
      plugins: { autoInstall: ["daytona", "kubernetes"], catalog: [] },
      adapters: { builtin: [] },
      environments: [],
    });
  });

  it("accepts empty features {} and autoInstall [] sections", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ features: {}, plugins: { autoInstall: [] } })),
    );
    expect(config).toEqual({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: {},
      plugins: { autoInstall: [], catalog: [] },
      adapters: { builtin: [] },
      environments: [],
    });
  });

  it("throws when the features section is missing (fail closed)", () => {
    const doc = { v: 1, mode: "cloud", catalogVersion: "2026.720.0", plugins: { autoInstall: [] } };
    expect(() => parseManagedConfigEnv(envWith(JSON.stringify(doc)))).toThrow(
      /requires a "features" object/,
    );
  });

  it("throws when the plugins section or autoInstall is missing (fail closed)", () => {
    const noPlugins = {
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: {},
    };
    expect(() => parseManagedConfigEnv(envWith(JSON.stringify(noPlugins)))).toThrow(
      /requires a "plugins" object/,
    );
    expect(() => parseManagedConfigEnv(envWith(validDoc({ plugins: {} })))).toThrow(
      /requires a "plugins.autoInstall" array/,
    );
  });

  it("returns a frozen document", () => {
    const config = parseManagedConfigEnv(envWith(validDoc()));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.features)).toBe(true);
    expect(Object.isFrozen(config?.plugins.autoInstall)).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseManagedConfigEnv(envWith("{not json"))).toThrow(
      /PAPERCLIP_MANAGED_CONFIG is not valid JSON/,
    );
  });

  it("throws on non-object documents", () => {
    expect(() => parseManagedConfigEnv(envWith("[]"))).toThrow(/must be a JSON object/);
    expect(() => parseManagedConfigEnv(envWith("42"))).toThrow(/must be a JSON object/);
    expect(() => parseManagedConfigEnv(envWith("null"))).toThrow(/must be a JSON object/);
    expect(() => parseManagedConfigEnv(envWith('"cloud"'))).toThrow(/must be a JSON object/);
  });

  it("throws on an unknown top-level key", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ extra: true })))).toThrow(
      /unknown top-level key "extra"/,
    );
  });

  it("throws on an unsupported v", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ v: 2 })))).toThrow(
      /unsupported "v" 2; this build supports v=1/,
    );
    expect(() => parseManagedConfigEnv(envWith(validDoc({ v: "1" })))).toThrow(/unsupported "v"/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(JSON.stringify({ mode: "cloud", catalogVersion: "x" })),
      ),
    ).toThrow(/unsupported "v"/);
  });

  it("throws on a non-cloud mode", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ mode: "self-hosted" })))).toThrow(
      /invalid "mode" "self-hosted"; expected "cloud"/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(JSON.stringify({ v: 1, catalogVersion: "x" }))),
    ).toThrow(/invalid "mode"/);
  });

  it("throws on a missing or empty catalogVersion", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(JSON.stringify({ v: 1, mode: "cloud" }))),
    ).toThrow(/non-empty string "catalogVersion"/);
    expect(() => parseManagedConfigEnv(envWith(validDoc({ catalogVersion: "" })))).toThrow(
      /non-empty string "catalogVersion"/,
    );
    expect(() => parseManagedConfigEnv(envWith(validDoc({ catalogVersion: 7 })))).toThrow(
      /non-empty string "catalogVersion"/,
    );
  });

  it("throws on a non-object features section", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ features: ["enableApps"] })))).toThrow(
      /"features" must be an object/,
    );
  });

  it("throws on an unknown feature key", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableTimeTravel: true } }))),
    ).toThrow(/unknown feature key "enableTimeTravel"/);
    // A server-managed bookkeeping field is not an overlayable feature.
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ features: { worktreeRunExecutionActivatedAt: true } })),
      ),
    ).toThrow(/unknown feature key "worktreeRunExecutionActivatedAt"/);
  });

  it("throws on a feature key the catalog does not mark tier \"managed\"", () => {
    // `enableStreamlinedLeftNavigation` is a real schema flag, but its catalog
    // tier is `preference` (tenant-controllable) — a managed-config document
    // targeting it has incompatible catalog semantics and must fail closed.
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ features: { enableStreamlinedLeftNavigation: true } })),
      ),
    ).toThrow(
      /"features" key "enableStreamlinedLeftNavigation" has tier "preference".*only tier "managed" keys/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableDecisions: false } }))),
    ).toThrow(/has tier "preference"/);
  });

  it("throws on non-boolean feature values", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableApps: "true" } }))),
    ).toThrow(/"features.enableApps" must be a boolean/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableApps: 1 } }))),
    ).toThrow(/"features.enableApps" must be a boolean/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableApps: null } }))),
    ).toThrow(/"features.enableApps" must be a boolean/);
  });

  it("throws on malformed plugins sections", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ plugins: [] })))).toThrow(
      /"plugins" must be an object/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { install: [] } }))),
    ).toThrow(/"plugins" has unknown key "install"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: "daytona" } }))),
    ).toThrow(/"plugins.autoInstall" must be an array/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: [""] } }))),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: [" daytona"] } }))),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: [42] } }))),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ plugins: { autoInstall: ["daytona", "daytona"] } })),
      ),
    ).toThrow(/duplicate entry "daytona"/);
  });
});

describe("parseManagedConfigEnv plugins.catalog section", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    key: "acme-operations",
    pluginKey: "acme.operations",
    relativePath: "acme/operations",
    ...overrides,
  });

  const withCatalog = (catalog: unknown, autoInstall: unknown = ["acme-operations"]) =>
    validDoc({ plugins: { autoInstall, catalog } });

  it("defaults to an empty list when the section is absent (pre-section documents keep booting)", () => {
    expect(parseManagedConfigEnv(envWith(validDoc()))?.plugins.catalog).toEqual([]);
  });

  it("parses a declared entry elected by autoInstall", () => {
    const config = parseManagedConfigEnv(envWith(withCatalog([entry()])));
    expect(config?.plugins.catalog).toEqual([
      { key: "acme-operations", pluginKey: "acme.operations", relativePath: "acme/operations" },
    ]);
    expect(config?.plugins.autoInstall).toEqual(["acme-operations"]);
  });

  it("throws on a malformed section or entry", () => {
    expect(() => parseManagedConfigEnv(envWith(withCatalog({})))).toThrow(
      /"plugins.catalog" must be an array/,
    );
    expect(() => parseManagedConfigEnv(envWith(withCatalog(["acme-operations"])))).toThrow(
      /"plugins.catalog\[0\]" must be an object/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(withCatalog([entry({ extra: 1 })]))),
    ).toThrow(/"plugins.catalog\[0\]" has unknown key "extra"/);
    expect(() =>
      parseManagedConfigEnv(envWith(withCatalog([{ key: "acme-operations", pluginKey: "acme.operations" }]))),
    ).toThrow(/"plugins.catalog\[0\]" requires "relativePath"/);
  });

  it("rejects a pathOverrideEnvVar key outright (a document cannot introduce a relocating env var)", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(withCatalog([entry({ pathOverrideEnvVar: "ACME_PLUGIN_PATH" })])),
      ),
    ).toThrow(/"plugins.catalog\[0\]" has unknown key "pathOverrideEnvVar"/);
  });

  it("throws on a malformed key or pluginKey", () => {
    expect(() => parseManagedConfigEnv(envWith(withCatalog([entry({ key: "Acme_Ops" })])))).toThrow(
      /"plugins.catalog\[0\].key" must be a lowercase catalog key/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(withCatalog([entry({ pluginKey: "Acme Ops" })]))),
    ).toThrow(/"plugins.catalog\[0\].pluginKey" must be a plugin manifest id/);
  });

  // The lexical half of path containment: rejected on spelling, before any
  // filesystem call, so no realpath or mount can influence the outcome.
  it("rejects a relativePath that could escape the catalog root", () => {
    const rejected = [
      "../../etc",
      "acme/../../etc",
      "/etc/passwd",
      "~/evil",
      "acme\\operations",
      ".hidden/operations",
      "a/b/c/d",
      "",
      " acme/operations",
    ];
    for (const relativePath of rejected) {
      expect(() =>
        parseManagedConfigEnv(envWith(withCatalog([entry({ relativePath })]))),
      ).toThrow(/"plugins.catalog\[0\].relativePath"/);
    }
  });

  it("throws on duplicate key or pluginKey within the section", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(
          withCatalog([entry(), entry({ pluginKey: "acme.other" })], ["acme-operations"]),
        ),
      ),
    ).toThrow(/duplicate key "acme-operations"/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(
          withCatalog(
            [entry(), entry({ key: "acme-other", relativePath: "acme/other" })],
            ["acme-operations", "acme-other"],
          ),
        ),
      ),
    ).toThrow(/duplicate pluginKey "acme.operations"/);
  });

  it("throws when a declared entry is never elected by autoInstall (dead configuration)", () => {
    expect(() => parseManagedConfigEnv(envWith(withCatalog([entry()], ["daytona"])))).toThrow(
      /"plugins.catalog\[0\].key" is "acme-operations", which is not in "plugins.autoInstall"/,
    );
  });
});

describe("parseManagedConfigEnv adapters.builtin section", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    type: "my_adapter",
    relativePath: "my-adapter",
    ...overrides,
  });

  const withAdapters = (adapters: unknown) => validDoc({ adapters });

  it("defaults to an empty list when the section is absent (pre-section documents keep booting)", () => {
    expect(parseManagedConfigEnv(envWith(validDoc()))?.adapters.builtin).toEqual([]);
  });

  it("parses a declared adapter", () => {
    const config = parseManagedConfigEnv(envWith(withAdapters({ builtin: [entry()] })));
    expect(config?.adapters.builtin).toEqual([
      { type: "my_adapter", relativePath: "my-adapter" },
    ]);
  });

  it("throws on a malformed section or entry", () => {
    expect(() => parseManagedConfigEnv(envWith(withAdapters([])))).toThrow(
      /"adapters" must be an object/,
    );
    expect(() => parseManagedConfigEnv(envWith(withAdapters({ external: [] })))).toThrow(
      /"adapters" has unknown key "external"/,
    );
    expect(() => parseManagedConfigEnv(envWith(withAdapters({ builtin: {} })))).toThrow(
      /"adapters.builtin" must be an array/,
    );
    expect(() => parseManagedConfigEnv(envWith(withAdapters({ builtin: ["x"] })))).toThrow(
      /"adapters.builtin\[0\]" must be an object/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(withAdapters({ builtin: [entry({ packageName: "x" })] }))),
    ).toThrow(/"adapters.builtin\[0\]" has unknown key "packageName"/);
    expect(() =>
      parseManagedConfigEnv(envWith(withAdapters({ builtin: [{ type: "my_adapter" }] }))),
    ).toThrow(/"adapters.builtin\[0\]" requires "relativePath"/);
  });

  it("throws on a malformed adapter type", () => {
    for (const type of ["My_Adapter", "1adapter", "my-adapter", "a", ""]) {
      expect(() =>
        parseManagedConfigEnv(envWith(withAdapters({ builtin: [entry({ type })] }))),
      ).toThrow(/"adapters.builtin\[0\].type" must be an adapter type/);
    }
  });

  it("rejects a relativePath that could escape the adapter root", () => {
    for (const relativePath of ["../../etc", "/etc/passwd", "~/evil", "a\\b", ".hidden", "a/b/c/d"]) {
      expect(() =>
        parseManagedConfigEnv(envWith(withAdapters({ builtin: [entry({ relativePath })] }))),
      ).toThrow(/"adapters.builtin\[0\].relativePath"/);
    }
  });

  it("throws on a duplicate type within the section", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(withAdapters({ builtin: [entry(), entry({ relativePath: "other" })] })),
      ),
    ).toThrow(/"adapters.builtin" has duplicate type "my_adapter"/);
  });
});

describe("parseManagedConfigEnv environments section", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    name: "Daytona",
    provider: "daytona",
    config: { target: "us" },
    ...overrides,
  });

  it("defaults to an empty list when the section is absent (pre-section documents keep booting)", () => {
    const config = parseManagedConfigEnv(envWith(validDoc()));
    expect(config?.environments).toEqual([]);
  });

  it("parses a declared environment and freezes it", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ environments: [entry({ description: "Managed Daytona sandbox." })] })),
    );
    expect(config?.environments).toHaveLength(1);
    const spec = config?.environments[0];
    expect(spec?.name).toBe("Daytona");
    expect(spec?.description).toBe("Managed Daytona sandbox.");
    expect(spec?.provider).toBe("daytona");
    expect(spec?.config).toEqual({ target: "us" });
    expect(Object.isFrozen(config?.environments)).toBe(true);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec?.config)).toBe(true);
  });

  it("treats config and description as optional", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ environments: [{ name: "Daytona", provider: "daytona" }] })),
    );
    expect(config?.environments[0]?.config).toEqual({});
    expect(config?.environments[0]?.description).toBeUndefined();
  });

  it("rejects a non-array section and non-object entries", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: {} }))),
    ).toThrow(/"environments" must be an array/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: ["daytona"] }))),
    ).toThrow(/"environments\[0\]" must be an object/);
  });

  it("rejects more than one entry (single managed sandbox slot)", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry(), entry({ name: "Other", provider: "kubernetes" })] })),
      ),
    ).toThrow(/at most one entry/);
  });

  it("rejects unknown entry keys", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ envVars: {} })] }))),
    ).toThrow(/unknown key "envVars"/);
  });

  it("rejects malformed names, descriptions, and providers", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ name: "" })] }))),
    ).toThrow(/"environments\[0\].name"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ name: " Daytona" })] }))),
    ).toThrow(/"environments\[0\].name"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ description: " " })] }))),
    ).toThrow(/"environments\[0\].description"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ provider: 7 })] }))),
    ).toThrow(/"environments\[0\].provider"/);
  });

  it("rejects a provider that plugins.autoInstall does not provision", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ provider: "modal" })] }))),
    ).toThrow(/not in "plugins.autoInstall"/);
  });

  it("rejects a config that sets provider", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry({ config: { provider: "daytona" } })] })),
      ),
    ).toThrow(/must not set "provider"/);
  });

  it("rejects secret-bearing config keys at any depth (secrets travel as env vars)", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry({ config: { apiKey: "not-a-real-key" } })] })),
      ),
    ).toThrow(/looks secret-bearing/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry({ config: { auth: { accessToken: "t" } } })] })),
      ),
    ).toThrow(/auth.accessToken/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(
          validDoc({ environments: [entry({ config: { adapters: [{ clientSecret: "s" }] } })] }),
        ),
      ),
    ).toThrow(/adapters\[0\].clientSecret/);
  });
});

describe("getManagedInstanceConfig", () => {
  it("caches by raw env value and reparses when it changes", () => {
    const raw = validDoc();
    const first = getManagedInstanceConfig(envWith(raw));
    const second = getManagedInstanceConfig(envWith(raw));
    expect(second).toBe(first);

    const changed = getManagedInstanceConfig(
      envWith(validDoc({ catalogVersion: "2026.721.0" })),
    );
    expect(changed?.catalogVersion).toBe("2026.721.0");
    expect(changed).not.toBe(first);

    expect(getManagedInstanceConfig(envWith(undefined))).toBeNull();
  });

  it("rethrows parse failures on every call instead of caching them", () => {
    expect(() => getManagedInstanceConfig(envWith("{bad"))).toThrow(/not valid JSON/);
    expect(() => getManagedInstanceConfig(envWith("{bad"))).toThrow(/not valid JSON/);
  });
});
