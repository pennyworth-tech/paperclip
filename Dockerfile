# syntax=docker/dockerfile:1.20
FROM node:24-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/google-sheets-mcp-server/package.json packages/google-sheets-mcp-server/
COPY packages/kv-demo-mcp-server/package.json packages/kv-demo-mcp-server/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/paperclip-runner/package.json packages/paperclip-runner/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/tailscale-https-broker/package.json packages/tailscale-https-broker/
COPY packages/teams-catalog/package.json packages/teams-catalog/
# Every adapter package's manifest, so a distributor that ships an extra
# adapter under this root needs no Dockerfile edit (same idiom as the
# sandbox-provider plugins below).
COPY --parents packages/adapters/./*/package.json packages/adapters/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends cargo rustc \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
# The server build runs scripts/write-build-stamp.mjs, which stamps the built
# commit into dist/build-info.json. The build context has no .git, so the
# script reads PAPERCLIP_BUILD_COMMIT instead. Docker exposes an ARG to the
# next RUN as an environment variable, so declare it here — in the build
# stage — before the server build. The production stage below declares the
# same ARG again for the runtime fallback; an ARG goes out of scope at the
# end of its stage. Empty for local `docker build`, which then writes no stamp.
ARG PAPERCLIP_BUILD_COMMIT=""
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
RUN rm -rf packages/paperclip-runner/runner/target

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
# Real version for this build, computed from `git describe` on the CI runner
# (the image has no .git, so the server cannot derive it at runtime). Empty for
# local `docker build`, which just leaves the server on its normal fallbacks.
ARG PAPERCLIP_BUILD_VERSION=""
# The exact commit this image was built from, for the same reason: server-info
# falls back to PAPERCLIP_BUILD_COMMIT when git is unavailable, which feeds the
# /api/health `commit` field that deploy tooling verifies. Empty locally.
ARG PAPERCLIP_BUILD_COMMIT=""
# Busts the tool layer below on demand. It no longer advances the tool
# versions on its own — every specifier is pinned — so CI stamps it only to
# force a deliberate rebuild of the layer.
ARG CLI_TOOLS_CACHE_EPOCH=""
# Harness versions, resolved on 2026-09-19 and frozen (BAC-4671 tasks 4.2/4.3).
# Every specifier used to be `@latest`, which meant the versions in the serving
# image were whatever the layer last resolved — unknown, and one cache-buster
# edit upgraded all five at once. That is the shape of the 2026-08-11 incident,
# where a claude CLI that auto-updated through a shim took the fleet down.
# Bumping a harness is now a reviewable one-line diff.
ARG CLAUDE_VERSION=2.1.278
ARG CODEX_VERSION=0.155.1
ARG OPENCODE_VERSION=1.18.31
ARG GEMINI_VERSION=0.60.0
ARG KIMI_VERSION=2.0.2
# `@fission-ai/openspec` is the real package. The bare `openspec` name on npm
# is an unrelated 0.0.0 squat — installing it gets you nothing and no error.
ARG OPENSPEC_VERSION=1.2.0
# The devcontainers CLI, which `devcontainer up` is. It spawns `docker` as a
# subprocess, so it is useless without the docker client below.
ARG DEVCONTAINERS_CLI_VERSION=0.89.0
# entire ships GitHub release tarballs, not an npm package (it is a Homebrew
# cask locally), so it installs by tarball with a checksum below.
ARG ENTIRE_VERSION=0.10.6
# The docker CLIENT only. The daemon runs in a separate privileged dind
# sidecar and this container reaches it over DOCKER_HOST, so this image stays
# unprivileged. Installed from Docker's static tarball rather than
# `docker-ce-cli` so no third-party apt repo and keyring enter the image, and
# so the one binary we want is the only one extracted: the tarball also carries
# dockerd/containerd/runc, and none of them belong here.
ARG DOCKER_CLI_VERSION=29.8.1
WORKDIR /app
# Tool and OS layer BEFORE the app copy: it references nothing from /app, and
# the app copy changes on every commit — ordered the other way around, this
# (the single most expensive layer: four CLI toolchains + apt, per arch) can
# never hit the layer cache and rebuilds on every build.
#
# `python3-venv`: arborist is a Python tool, and trixie-slim splits venv out of
# `python3`, so `python3 -m venv` fails with a bare `python3` install.
# `openssh-client`: the repo contract uses git@github.com: remotes and agents
# now push from inside this container. It was originally installed for herdr's
# `ssh -NT -L` tunnel; herdr is gone, the transport is not (task 4.4).
RUN echo "cli-tools-epoch: ${CLI_TOOLS_CACHE_EPOCH}" \
  && npm install --global --omit=dev \
       "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
       "@openai/codex@${CODEX_VERSION}" \
       "opencode-ai@${OPENCODE_VERSION}" \
       "@google/gemini-cli@${GEMINI_VERSION}" \
       "@moonshot-ai/kimi-code@${KIMI_VERSION}" \
       "@fission-ai/openspec@${OPENSPEC_VERSION}" \
       "@devcontainers/cli@${DEVCONTAINERS_CLI_VERSION}" \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# `curl -O`, not `-o`: `sha256sum -c` reads the filename out of checksums.txt
# and looks for it on disk, so the downloaded name must be preserved verbatim.
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) A=amd64 ;; arm64) A=arm64 ;; *) echo "unsupported $arch"; exit 1 ;; esac; \
    f="entire_linux_${A}.tar.gz"; cd /tmp; \
    curl -fsSL -O "https://github.com/entireio/cli/releases/download/v${ENTIRE_VERSION}/${f}"; \
    curl -fsSL -O "https://github.com/entireio/cli/releases/download/v${ENTIRE_VERSION}/checksums.txt"; \
    grep " ${f}\$" checksums.txt | sha256sum -c -; \
    tar -xzf "$f" -C /usr/local/bin entire; chmod +x /usr/local/bin/entire; rm -f "$f" checksums.txt

# Docker's static tarball is published under the kernel arch name, not the
# Debian one. Only `docker/docker` (the client) is extracted; extracting
# `dockerd` here would invite someone to run a daemon in this container, which
# is exactly what the unprivileged-container + dind-sidecar split avoids.
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) A=x86_64 ;; arm64) A=aarch64 ;; *) echo "unsupported $arch"; exit 1 ;; esac; \
    cd /tmp; \
    curl -fsSL -o docker.tgz "https://download.docker.com/linux/static/stable/${A}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    tar -xzf docker.tgz --strip-components=1 -C /usr/local/bin docker/docker; \
    chmod +x /usr/local/bin/docker; rm -f docker.tgz; \
    docker --version | grep -qF "${DOCKER_CLI_VERSION}"

# Freeze what ACTUALLY resolved into the image, not what was asked for. A
# build-time pin does not stop a harness self-updating at runtime — that is the
# failure already on record — so the spawn path asserts against this file. It
# has to be a file: an ARG is out of scope the moment the build ends, and a
# runtime check against a value the image no longer carries proves nothing.
# The versions are read back from npm rather than echoed from the ARGs, so a
# specifier that silently resolved to something else fails the build here.
RUN set -eu; \
    mkdir -p /etc/paperclip; \
    npm ls -g --depth=0 --json > /tmp/npm-globals.json || true; \
    node -e ' \
      const fs = require("fs"); \
      const deps = (JSON.parse(fs.readFileSync("/tmp/npm-globals.json", "utf8")).dependencies) || {}; \
      const want = { \
        claude: ["@anthropic-ai/claude-code", process.env.CLAUDE_VERSION], \
        codex: ["@openai/codex", process.env.CODEX_VERSION], \
        opencode: ["opencode-ai", process.env.OPENCODE_VERSION], \
        gemini: ["@google/gemini-cli", process.env.GEMINI_VERSION], \
        kimi: ["@moonshot-ai/kimi-code", process.env.KIMI_VERSION], \
        openspec: ["@fission-ai/openspec", process.env.OPENSPEC_VERSION], \
        devcontainer: ["@devcontainers/cli", process.env.DEVCONTAINERS_CLI_VERSION], \
      }; \
      const out = {}; \
      for (const [key, [pkg, expected]] of Object.entries(want)) { \
        const got = deps[pkg] && deps[pkg].version; \
        if (got !== expected) { \
          console.error(`ERROR: ${pkg} resolved to ${got} but the build pinned ${expected}`); \
          process.exit(1); \
        } \
        out[key] = got; \
      } \
      out.entire = process.env.ENTIRE_VERSION; \
      out.docker = process.env.DOCKER_CLI_VERSION; \
      fs.writeFileSync("/etc/paperclip/harness-versions.json", JSON.stringify(out) + "\n"); \
    '; \
    rm -f /tmp/npm-globals.json; \
    cat /etc/paperclip/harness-versions.json

# A bare GITHUB_TOKEN in the environment does nothing for `git push` — git never
# reads it. The server's own helper (server/src/services/git-credentials.ts) is
# per-invocation: it passes `-c credential.…helper=…` on each git command it
# runs itself, and nothing of it persists into a workspace's .git/config, so a
# harness child running plain `git push` has no credential at all.
#
# This installs the same helper system-wide. It goes in /etc/gitconfig, NOT
# ~/.gitconfig: HOME is /paperclip, which is a mounted volume, so a home-dir
# config is whatever the volume happens to carry and is not part of the image.
#
# The helper follows git-credentials.ts exactly on the two things that matter:
# the token is read from the environment, so it never appears in argv, in a URL,
# or on disk; and the request is re-validated from the helper's own stdin so a
# repository-local `url.<base>.insteadOf` rewrite cannot steer it at another
# host. The URL-scoped install below is the second, independent gate.
#
# Token precedence: PAPERCLIP_GIT_TOKEN is what the server's per-invocation
# helper sets, and `sanitizeInheritedPaperclipEnv` strips host PAPERCLIP_* values
# from harness children — so GITHUB_TOKEN/GH_TOKEN, which reach a child through a
# config `secret_ref` binding, are the names that actually work in an agent run.
#
# The file must be named `git-credential-paperclip` and the config value must be
# the bare `paperclip`: git resolves a helper name by prefixing it with
# `git-credential-`, so configuring the full filename makes git look for
# `git-credential-git-credential-paperclip` and fail.
COPY scripts/git-credential-paperclip.sh /usr/local/bin/git-credential-paperclip
RUN set -eu; \
    chmod 0755 /usr/local/bin/git-credential-paperclip; \
    git config --system credential.helper ""; \
    git config --system "credential.https://github.com.helper" paperclip; \
    git config --system "credential.https://www.github.com.helper" paperclip; \
    test -r /etc/gitconfig

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --chown=node:node --from=build /app /app

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_BUILD_VERSION=${PAPERCLIP_BUILD_VERSION} \
  PAPERCLIP_BUILD_COMMIT=${PAPERCLIP_BUILD_COMMIT} \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

EXPOSE 3100

# tini, not node, is PID 1. The entrypoint ends in `exec`, so without an init
# node inherits PID 1 and never wait()s the orphans the kernel re-parents onto
# it -- agent runs spawn git/claude/esbuild/sh descendants that outlive their
# leader, so they pile up as permanent zombies (~79/h measured) until the
# cgroup pid limit is exhausted and *every* fork() in the container fails.
# tini reaps adopted orphans and forwards signals, so the exec chain below and
# graceful shutdown are unchanged. Mirrors docker/agent-runtime/Dockerfile.base.
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]

# Local development variant (build with `--target local`), used by
# docker/docker-compose.local.yml. Same Dockerfile as production on purpose: a
# second Dockerfile would stop a local run from being evidence about the
# production image. Until this stage existed the local compose file could not
# build at all — it named a target that was not here.
#
# It declares nothing of its own. Everything that differs between local and
# production is a mount or an environment variable, and those belong in the
# compose file where a developer can see them: the developer's own ~/.claude,
# ~/.codex and ~/.local/share/opencode bound in WRITABLE (the session stores
# live there, and a read-only mount boots fine and silently breaks every
# resume), the worktree root on a bind mount so worktrees are inspectable from
# the host, and a local Postgres instead of Cloud SQL.
#
# It must stay BEFORE `cloud-plugins` below. Appended after `cloud` it would
# become the last stage in the file, which is what an untargeted
# `docker build` produces — silently changing what docker/docker-compose.yml
# builds. It also deliberately adds no ENTRYPOINT: tini stays PID 1 (see
# server/src/__tests__/container-init-reaping.test.ts).
FROM production AS local

# Cloud image variant (build with `--target cloud`): the production image
# plus built bundled plugins. Managed instances receive a
# `plugins.autoInstall` key list through PAPERCLIP_MANAGED_CONFIG and
# install those plugins from the bundled catalog at boot
# (server/src/services/bundled-plugins.ts), which requires each plugin's
# dist/ to exist in the image — the default image ships only their source,
# so auto-install logs "bundle not present" and skips. The plugins are
# built in this separate target so the default (self-hosted) image stays
# lean; CI pins the default build to `--target production`, which is
# byte-identical to before this stage existed.
#
# The subtrees named here are intentionally excluded from the pnpm workspace
# (see pnpm-workspace.yaml), so each plugin installs standalone exactly as its
# README prescribes; naming a workspace member instead is unsupported, since
# `--ignore-workspace` cannot resolve its `workspace:*` deps. Installing in a
# `build`-based stage (not `production`) keeps devDependencies available for
# tsc: `production` sets NODE_ENV=production, which would make pnpm skip them.
#
# CLOUD_BUNDLED_PLUGINS is the space-separated list of plugins to build into
# the variant. An entry containing `/` is a path relative to packages/plugins/;
# a bare name means sandbox-providers/<name>. Only what managed deployments
# actually auto-install belongs here — every entry adds its node_modules
# to the image. Growing the list is a one-line workflow change.
FROM build AS cloud-plugins
ARG CLOUD_BUNDLED_PLUGINS="daytona"
RUN set -eu; \
  for name in $CLOUD_BUNDLED_PLUGINS; do \
    case "$name" in \
      *..*) echo "ERROR: CLOUD_BUNDLED_PLUGINS entry '$name' may not contain '..'" >&2; exit 1 ;; \
    esac; \
    case "$name" in \
      */*) dir="packages/plugins/$name" ;; \
      *) dir="packages/plugins/sandbox-providers/$name" ;; \
    esac; \
    test -d "$dir" || { echo "ERROR: unknown bundled plugin '$name'" >&2; exit 1; }; \
    pnpm -C "$dir" install --ignore-workspace --no-lockfile; \
    pnpm -C "$dir" build; \
    test -f "$dir/dist/manifest.js" || { echo "ERROR: $dir is missing dist/manifest.js after build" >&2; exit 1; }; \
  done

# The hosted image variant ships selected optional peer packages
# pre-installed. A managed tenant then needs no separate install step.
# The self-hosted image stays on the opt-in contract: it never runs this
# stage, so a package like `@sentry/node` stays a true optional peer
# dependency. A self-hosted operator installs it by hand (see
# doc/observability.md).
#
# CLOUD_BUNDLED_SERVER_DEPS names the optional peer packages to install.
# The value is a space-separated list, the same shape as
# CLOUD_BUNDLED_PLUGINS above. The stage reads each package's version
# from the `peerDependencies` block of `server/package.json` at build
# time, so the version has one committed home.
#
# The stage fails the build in three cases:
# - the argument is empty
# - server/package.json declares no version for a named package
# - the named package is not an optional peer
#
# This check keeps the argument limited to packages the server already
# treats as optional.
#
# The install happens in its own isolated directory, not inside
# `server`'s own workspace install. The self-hosted target above never
# gains these packages this way. The directory sits under `/app`, not
# `server/`, and `--ignore-workspace` below excludes it from the pnpm
# workspace. From that directory, pnpm still finds the `packageManager`
# pin in the repo's own `package.json` by walking up — the same pnpm
# version the rest of the build uses.
#
# The install writes no lock file (`--no-lockfile`, the same flag the
# `cloud-plugins` stage above uses). Two builds of the same commit can
# therefore install different transitive versions of a named package.
# Three facts make this an accepted trade-off:
# - the `cloud-plugins` stage above already has the same property, with
#   the same flag
# - the direct version of each named package comes from one exact,
#   single-sourced place: the `peerDependencies` block of
#   `server/package.json`
# - an automated check asserts the installed direct version after every
#   build, so a transitive drift that breaks the package still fails the
#   build
FROM build AS cloud-server-deps
WORKDIR /app/.cloud-server-deps
ARG CLOUD_BUNDLED_SERVER_DEPS="@sentry/node"
RUN set -eu; \
  test -n "$CLOUD_BUNDLED_SERVER_DEPS" || { echo "ERROR: CLOUD_BUNDLED_SERVER_DEPS is empty; name at least one optional peer package to install" >&2; exit 1; }; \
  echo '{"name":"paperclip-cloud-server-deps","private":true}' > package.json; \
  specifiers=""; \
  for name in $CLOUD_BUNDLED_SERVER_DEPS; do \
    version="$(node -e "const pkg=require('/app/server/package.json'); const name=process.argv[1]; const version=(pkg.peerDependencies||{})[name]; if(!version){console.error('ERROR: server/package.json declares no peerDependencies version for '+JSON.stringify(name));process.exit(1);} const meta=(pkg.peerDependenciesMeta||{})[name]; if(!meta||meta.optional!==true){console.error('ERROR: '+JSON.stringify(name)+' is not declared as an optional peer dependency in server/package.json; CLOUD_BUNDLED_SERVER_DEPS may name only optional peer packages');process.exit(1);} process.stdout.write(version);" "$name")"; \
    test -n "$version" || { echo "ERROR: could not resolve a version for '$name'" >&2; exit 1; }; \
    specifiers="$specifiers ${name}@${version}"; \
  done; \
  test -n "$specifiers" || { echo "ERROR: CLOUD_BUNDLED_SERVER_DEPS names no package" >&2; exit 1; }; \
  pnpm add --ignore-workspace --no-lockfile $specifiers

FROM production AS cloud
# Copy the whole bundled-plugin tree rather than just sandbox-providers/, so a
# plugin that lives under another subtree of packages/plugins/ also arrives
# with its built dist/. `production` already carries every plugin's source, so
# this only adds the build outputs and the node_modules of whatever
# CLOUD_BUNDLED_PLUGINS actually named.
COPY --chown=node:node --from=cloud-plugins /app/packages/plugins /app/packages/plugins
# Land the isolated install inside the server's own `node_modules`, the
# directory Node's module resolution walks up to from `/app/server` for
# both a CommonJS `require.resolve` and an ECMAScript `import` — an entry
# on `NODE_PATH` would satisfy only the first and silently fail the second.
COPY --chown=node:node --from=cloud-server-deps /app/.cloud-server-deps/node_modules /app/server/node_modules
