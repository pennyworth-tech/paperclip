#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Seed the codex credential from CODEX_AUTH_JSON, but ONLY if no auth.json is
# already on disk.
#
# Never overwrite. Codex refreshes its OAuth token in place during a run and
# that write lands on the persistent home, so once it has refreshed even once
# the copy on disk is NEWER than the secret. Re-seeding on every boot would roll
# the credential back to a stale token, and the failure would present as a
# random expiry rather than as the self-inflicted rollback it is. The secret is
# a disaster-recovery seed, not the live credential.
#
# It runs before the privilege branch below, so it covers both the unprivileged
# `exec` path and the gosu one. A seed that cannot be written warns and does not
# stop the boot: the server may not use codex at all, and refusing to start over
# an optional credential turns a missing convenience into an outage.
seed_codex_auth() {
    [ -n "${CODEX_AUTH_JSON:-}" ] || return 0
    # $HOME is root's here, not the runtime user's, so resolve the codex home
    # the same way the adapter does (CODEX_HOME else $HOME/.codex) but off
    # PAPERCLIP_HOME, which is the account the server actually runs as.
    codex_home="${CODEX_HOME:-${PAPERCLIP_HOME:-/paperclip}/.codex}"
    if [ -s "$codex_home/auth.json" ]; then
        echo "docker-entrypoint.sh: $codex_home/auth.json exists; leaving the live codex credential alone" >&2
        return 0
    fi
    # printf with a literal '%s' format, not echo: the JSON carries backslashes
    # and some shells' echo interprets them.
    if ! (
        umask 077
        mkdir -p "$codex_home" \
            && printf '%s' "$CODEX_AUTH_JSON" > "$codex_home/auth.json"
    ); then
        echo "docker-entrypoint.sh: could not seed $codex_home/auth.json; codex will have no credential" >&2
        return 0
    fi
    if [ "$(id -u)" -eq 0 ]; then
        chown "$PUID:$PGID" "$codex_home" "$codex_home/auth.json"
    fi
    echo "docker-entrypoint.sh: seeded $codex_home/auth.json from CODEX_AUTH_JSON" >&2
}

seed_codex_auth
# Drop the seed from the environment before exec'ing the server. CODEX_ is an
# allowed namespace in the child-env allowlist, so a CODEX_AUTH_JSON left in the
# server's environment would be forwarded verbatim to every harness child -- a
# whole OAuth credential handed to agent-controlled code for no reason. The
# entrypoint is the only thing that needs it, and it is done with it now.
unset CODEX_AUTH_JSON

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# Ensure the app home is owned by the runtime user BEFORE dropping
# privileges -- not only after a UID/GID remap. A freshly mounted volume
# (Docker named volume, Railway volume, Kubernetes PV) arrives root-owned
# and shadows the image's build-time chown, so with the default UID the old
# remap-only condition dropped privileges onto an unwritable home and the
# server crashed on its first mkdir. The probe is a first-mismatch find
# over the WHOLE tree (uid and gid): a root-owned mount or descendant
# (init containers, backup restores, files written before a remap) is
# found immediately and repaired recursively, a GID-only remap is caught,
# and a fully-correct tree costs one metadata-only walk with no chown.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ] && [ -n "$(find "$home_dir" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$home_dir"
fi

exec gosu node "$@"
