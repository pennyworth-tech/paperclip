import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GIT_CREDENTIAL_TOKEN_ENV_KEY } from "../services/git-credentials.js";

/**
 * Drift guard for the combined agent image (BAC-4671).
 *
 * Execution moved off the herdr worker and into this container, so the image is
 * now the thing that determines which harness binary an agent run gets and
 * whether it can authenticate a push. None of that is observable from a unit
 * test of the server; these are static assertions over the files that build the
 * image, which is what keeps the decisions from being quietly undone.
 *
 * The behavioural halves live where they can run: the child-env boundary in
 * packages/adapter-utils/src/acpx-engine/child-env-allowlist.test.ts (which
 * spawns a real ACP agent), and orphan reaping in
 * scripts/assert-orphan-reaping.sh against a built image.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), "utf8");

const dockerfile = read("Dockerfile");
const entrypoint = read("scripts", "docker-entrypoint.sh");
const credentialHelper = read("scripts", "git-credential-paperclip.sh");
const localCompose = read("docker", "docker-compose.local.yml");

/** The stage names a Dockerfile declares, in file order. */
function stageNames(source: string): string[] {
  return [...source.matchAll(/^FROM \S+ AS (\S+)\s*$/gm)].map((m) => m[1]);
}

/** The npm specifiers every `npm install --global` line in the file asks for. */
function globalNpmSpecifiers(source: string): string[] {
  return [...source.matchAll(/npm install --global[\s\S]*?(?=\n\s*&&\s*apt-get|\n\s*$)/g)].flatMap((m) =>
    [...m[0].matchAll(/"([^"]+@[^"]+)"|\s(@?[\w./-]+@[\w.-]+)/g)].map((token) => token[1] ?? token[2]),
  );
}

describe("harness version pinning", () => {
  it("installs no harness at a floating @latest", () => {
    // Floating specifiers meant the versions in the serving image were whatever
    // the layer last resolved, and one cache-buster edit upgraded all of them at
    // once -- the shape of the 2026-08-11 incident where an auto-updating claude
    // CLI took the fleet down.
    const specifiers = globalNpmSpecifiers(dockerfile);
    expect(specifiers.length, "the Dockerfile must still install the harnesses globally").toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier, `${specifier} must be pinned, not floating`).not.toMatch(/@(latest|next|beta)$/);
    }
  });

  it.each([
    ["CLAUDE_VERSION", "@anthropic-ai/claude-code"],
    ["CODEX_VERSION", "@openai/codex"],
    ["OPENCODE_VERSION", "opencode-ai"],
    ["GEMINI_VERSION", "@google/gemini-cli"],
    ["KIMI_VERSION", "@moonshot-ai/kimi-code"],
    ["OPENSPEC_VERSION", "@fission-ai/openspec"],
    ["DEVCONTAINERS_CLI_VERSION", "@devcontainers/cli"],
  ])("pins %s and installs %s from it", (arg, pkg) => {
    expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=\\d`, "m"));
    expect(dockerfile).toContain(`"${pkg}@\${${arg}}"`);
  });

  it("never installs the bare `openspec` npm name", () => {
    // `openspec` on npm is an unrelated 0.0.0 squat. Installing it succeeds,
    // ships nothing usable, and produces no error to notice.
    for (const specifier of globalNpmSpecifiers(dockerfile)) {
      expect(specifier).not.toMatch(/^openspec@/);
    }
  });

  it("writes the resolved versions into the image for the runtime to assert against", () => {
    // A build-time pin does not stop a harness self-updating at runtime, and an
    // ARG is out of scope the moment the build ends -- so the spawn-time check
    // needs a file, and the file must hold what actually installed.
    expect(dockerfile).toContain("/etc/paperclip/harness-versions.json");
    expect(dockerfile, "read the versions back from npm rather than echoing the ARGs").toContain("npm ls -g");
  });
});

describe("image tooling", () => {
  it("keeps openssh-client, which authenticated push still needs", () => {
    // Dropped in an earlier draft as herdr tunnel leftovers. The repo contract
    // uses git@github.com: remotes and agents now push from in here.
    expect(dockerfile).toContain("openssh-client");
  });

  it("installs python3-venv, which trixie-slim splits out of python3", () => {
    // arborist is a Python tool; without this `python3 -m venv` fails.
    expect(dockerfile).toContain("python3-venv");
  });

  it("installs the docker CLIENT and no daemon", () => {
    // The daemon runs in a separate privileged dind sidecar; this container
    // stays unprivileged and reaches it over DOCKER_HOST. A docker socket or
    // daemon inside the container that runs agent code is root on the host by
    // another name.
    expect(dockerfile).toContain("docker/docker");
    expect(dockerfile, "extract only the client from the static tarball").not.toMatch(/tar -xzf docker\.tgz[^\n]*dockerd/);
    expect(dockerfile).not.toMatch(/apt-get install[^\n]*\bdocker-ce\b(?!-cli)/);
  });

  it("verifies the entire tarball against its published checksum", () => {
    expect(dockerfile).toContain("sha256sum -c -");
    // `curl -O`, not `-o`: sha256sum -c reads the filename out of checksums.txt
    // and looks for it on disk, so the downloaded name must survive.
    expect(dockerfile).toMatch(/curl -fsSL -O "https:\/\/github\.com\/entireio\/cli/);
  });
});

describe("local build target", () => {
  it("declares a `local` stage the local compose file can build", () => {
    expect(stageNames(dockerfile)).toContain("local");
    expect(localCompose).toContain("target: local");
  });

  it("does not make `local` the stage an untargeted build produces", () => {
    // Docker builds the LAST stage when no --target is given. `local` appended
    // after `cloud` would silently change what docker/docker-compose.yml builds.
    const stages = stageNames(dockerfile);
    expect(stages[stages.length - 1]).not.toBe("local");
    expect(stages.indexOf("local")).toBeLessThan(stages.indexOf("cloud-plugins"));
  });

  it("leaves PID 1 to the image in the local profile too", () => {
    // tini reaps the git/claude/esbuild/sh orphans agent runs leave behind
    // (~79/h measured). `init: true` here would nest docker-init around it.
    expect(/^\s*init:\s*true\s*$/m.test(localCompose)).toBe(false);
    expect(/^\s{4}pids_limit:\s*\d+\s*$/m.test(localCompose)).toBe(true);
  });
});

describe("git credential helper", () => {
  it("is registered under the bare name git resolves, not the filename", () => {
    // git prefixes a helper name with `git-credential-`, so configuring the
    // full filename makes it look for git-credential-git-credential-paperclip.
    expect(dockerfile).toContain('git config --system "credential.https://github.com.helper" paperclip');
    expect(dockerfile).toContain('git config --system "credential.https://www.github.com.helper" paperclip');
    expect(dockerfile).toContain("/usr/local/bin/git-credential-paperclip");
  });

  it("installs system-wide rather than into HOME, which is a mounted volume", () => {
    expect(dockerfile).toContain("git config --system");
    expect(dockerfile).not.toContain("git config --global");
  });

  it("enforces the same two gates as the server's per-invocation helper", () => {
    // server/src/services/git-credentials.ts re-validates the request from its
    // own stdin so an `insteadOf` rewrite cannot steer the token at another
    // host, and answers only `get`. The in-image helper is a second
    // implementation of the same contract, so it must not drift off either gate.
    expect(credentialHelper).toContain("host=github.com | host=www.github.com");
    expect(credentialHelper).toContain("protocol=https");
    expect(credentialHelper).toMatch(/\[ "\$\{1:-\}" = get \]/);
    expect(credentialHelper).toContain("username=x-access-token");
  });

  it("reads the token from the environment, never from argv or a file", () => {
    expect(credentialHelper).toContain(GIT_CREDENTIAL_TOKEN_ENV_KEY);
    // GITHUB_TOKEN / GH_TOKEN are the names that actually reach a harness child
    // (config `secret_ref` bindings); PAPERCLIP_* host values are stripped from
    // child environments by `sanitizeInheritedPaperclipEnv`.
    expect(credentialHelper).toContain("GITHUB_TOKEN");
    expect(credentialHelper).toContain("GH_TOKEN");
    expect(credentialHelper).not.toMatch(/password=\$\{?1/);
  });
});

describe("codex auth seeding", () => {
  it("seeds only when no auth.json is already on disk", () => {
    // Codex refreshes its OAuth token in place, so after the first refresh the
    // on-disk copy is newer than the secret. Re-seeding would roll it back, and
    // the failure would look like a random expiry.
    expect(entrypoint).toContain('if [ -s "$codex_home/auth.json" ]; then');
    expect(entrypoint).toContain("leaving the live codex credential alone");
  });

  it("drops the seed from the environment before exec'ing the server", () => {
    // CODEX_ is an allowed namespace in the child-env allowlist, so a
    // CODEX_AUTH_JSON left in the server env is forwarded verbatim to every
    // harness child -- a whole OAuth credential handed to agent-controlled code.
    expect(entrypoint).toContain("unset CODEX_AUTH_JSON");
    const unsetIndex = entrypoint.indexOf("unset CODEX_AUTH_JSON");
    expect(unsetIndex).toBeGreaterThan(entrypoint.indexOf("seed_codex_auth\n"));
    expect(unsetIndex, "the unset must precede every exec path").toBeLessThan(entrypoint.indexOf('exec "$@"'));
  });
});
