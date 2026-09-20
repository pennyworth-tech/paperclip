#!/bin/sh
# Paperclip's system-wide git credential helper, installed into the container
# image at /usr/local/bin/git-credential-paperclip and referenced from
# /etc/gitconfig (see the Dockerfile).
#
# This is the in-image counterpart of the server's per-invocation helper in
# server/src/services/git-credentials.ts, and it must keep that helper's two
# properties:
#
#   1. The token is read from the environment and written only to stdout. It
#      never appears in argv, in a remote URL, or in a file on disk — which is
#      why this is a credential helper at all rather than a rewritten remote.
#   2. The request is re-validated from the helper's own stdin. git applies
#      configuration like a repository-local `url.<base>.insteadOf` before it
#      asks for a credential, so a rewritten remote could otherwise request the
#      github.com token for an arbitrary host. The URL-scoped install in
#      /etc/gitconfig is the second, independent gate.
#
# `x-access-token` as the username authenticates classic PATs, fine-grained
# PATs, and GitHub App installation tokens alike.
#
# Only `get` answers. `store` and `erase` drain stdin and exit 0 silently: there
# is nothing to persist (the token comes from the environment on every call) and
# a non-zero exit from either would fail the git operation that triggered it.

set -eu

host_ok=
protocol_ok=
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    host=github.com | host=www.github.com) host_ok=1 ;;
    protocol=https) protocol_ok=1 ;;
  esac
done

[ "${1:-}" = get ] || exit 0
[ -n "$host_ok" ] || exit 0
[ -n "$protocol_ok" ] || exit 0

# Precedence matches what each caller can actually set. See the Dockerfile.
token="${PAPERCLIP_GIT_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"

# Answer nothing rather than an empty password: git then falls through to its
# other credential sources instead of retrying a credential it was just handed
# and failing with "Authentication failed" that names this helper.
[ -n "$token" ] || exit 0

printf 'username=x-access-token\npassword=%s\n' "$token"
