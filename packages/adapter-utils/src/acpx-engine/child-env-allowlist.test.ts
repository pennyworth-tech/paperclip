import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

/**
 * The ACP lane's child-env boundary (BAC-4671).
 *
 * Until this change `applyChildEnvAllowlist` had exactly one call site —
 * `runChildProcess`, the CLI lane — while `engine` defaults to "auto" (ACP
 * preferred) on both claude-local and codex-local. So on a default-configured
 * agent nothing was filtered: acpx's own `buildAgentEnvironment` copied the
 * server's whole `process.env` into the harness child, DATABASE_URL and every
 * injected secret with it. That was survivable while harnesses ran on a
 * separate worker; on the single VM the harness is a local child of the server
 * and can also reach the GCE metadata server, so it is not.
 *
 * These tests spawn a REAL ACP agent over stdio, the same way
 * `spawn-smoke.test.ts` does, and read back the env the agent actually
 * received. A mock of the acpx runtime could not prove this: the leak lived
 * inside acpx, not in Paperclip's own code.
 */

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-echo-agent.mjs");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

/** Run a real ACP agent and return the env variable NAMES it was spawned with. */
async function spawnAndReadChildEnvKeys(configEnv: Record<string, string>): Promise<string[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-child-env-"));
  tempRoots.push(root);
  const dumpPath = path.join(root, "child-env-keys.json");
  const logs: string[] = [];

  const result = await createAcpxEngineExecutor()({
    runId: "child-env-allowlist",
    agent: { id: "child-env-agent", companyId: "child-env-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      // The fixture writes its env key list here on `initialize`. The variable
      // is PAPERCLIP_-prefixed so the allowlist admits it by namespace.
      env: { PAPERCLIP_ACPX_ENV_DUMP: dumpPath, ...configEnv },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode, JSON.stringify({ result, logs }, null, 2)).toBe(0);
  return JSON.parse(await fs.readFile(dumpPath, "utf8")) as string[];
}

describe("ACP-spawned harness child environment", () => {
  it("does not hand the server's own secrets to the agent", async () => {
    // DATABASE_URL is the canonical one: the server needs it, no agent may read
    // it, and it matches no allowlist name or prefix. The value is a marker, not
    // a real DSN — nothing connects with it.
    vi.stubEnv("DATABASE_URL", "postgres://leak:leak@127.0.0.1:5432/leak");
    vi.stubEnv("PAPERCLIP_ACPX_LEAK_PROBE_SECRET", "must-not-reach-the-agent");

    const keys = await spawnAndReadChildEnvKeys({});

    expect(keys).not.toContain("DATABASE_URL");
    // A host PAPERCLIP_* value is dropped by `sanitizeInheritedPaperclipEnv`
    // before the allowlist admits the namespace, so namespace admission never
    // re-opens the host's own runtime variables.
    expect(keys).not.toContain("PAPERCLIP_ACPX_LEAK_PROBE_SECRET");
    // Sanity: the filter ran rather than the child simply getting nothing.
    expect(keys).toContain("PATH");
    expect(keys).toContain("HOME");
  }, 60_000);

  it("passes DOCKER_HOST through, which `devcontainer up` cannot work without", async () => {
    // `@devcontainers/cli` spawns `docker` as a subprocess. On the VM the
    // daemon is a separate privileged dind sidecar reached over DOCKER_HOST, so
    // a `docker` child that does not inherit it dials a local socket that
    // deliberately does not exist and fails with a connection error.
    vi.stubEnv("DOCKER_HOST", "tcp://dind:2375");

    const keys = await spawnAndReadChildEnvKeys({});

    expect(keys).toContain("DOCKER_HOST");
  }, 60_000);

  it("still delivers config-bound credentials, which carry no allowlistable name", async () => {
    // This is the half a naive filter breaks. A `secret_ref` binding may name
    // anything, and these three are how agent credentials actually arrive
    // (credential-bootstrap.md): none of them matches a static allowlist entry
    // — GH_TOKEN and GITHUB_TOKEN match no prefix at all — so they survive only
    // through the `PAPERCLIP_CHILD_ENV_CONFIG_KEYS` additional-allowed path.
    const keys = await spawnAndReadChildEnvKeys({
      GITHUB_TOKEN: "config-bound-github-token",
      GH_TOKEN: "config-bound-gh-token",
      CLAUDE_CODE_OAUTH_TOKEN: "config-bound-claude-token",
    });

    expect(keys).toContain("GITHUB_TOKEN");
    expect(keys).toContain("GH_TOKEN");
    expect(keys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // The bookkeeping marker is Paperclip's own and must never reach the child.
    expect(keys).not.toContain("PAPERCLIP_CHILD_ENV_CONFIG_KEYS");
  }, 60_000);

  it("strips the Claude Code nesting guards the CLI lane strips", async () => {
    // A `claude` child that sees these refuses to start with "cannot be
    // launched inside another session". They leak in whenever the server is
    // itself run from a Claude Code session — which is exactly how the local
    // compose profile is driven. The CLI lane has always deleted them; before
    // this change the ACP lane did not.
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");

    const keys = await spawnAndReadChildEnvKeys({});

    expect(keys).not.toContain("CLAUDECODE");
    expect(keys).not.toContain("CLAUDE_CODE_ENTRYPOINT");
  }, 60_000);
});
