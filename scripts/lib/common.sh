# shellcheck shell=bash
#
# scripts/lib/common.sh -- shared helpers for scripts/deploy.sh, backup.sh,
# restore.sh and compose.sh. Source it, don't execute it.
#
# Defines:
#   ROOT_DIR, COMPOSE_FILE, ENV_FILE, DEPLOY_STATE_DIR, CURRENT_TAG_FILE
#     (ENV_FILE defaults to $ROOT_DIR/.env; STB_ENV_FILE overrides it, for tests.
#     DEPLOY_STATE_DIR defaults to $ROOT_DIR/.deploy; STB_DEPLOY_STATE_DIR
#     overrides it, for tests -- so a test run's .deploy/current_tag never
#     reads or writes the real repo's deploy state.)
#   env_get KEY        print KEY's value from $ENV_FILE ("" if absent)
#   read_current_tag   print the tag recorded in $CURRENT_TAG_FILE ("" if none)
#   compose ARGS...    docker compose for this stack (needs COMPOSE_PROJECT).
#     STB_COMPOSE_EXTRA_FILE, if set, is passed as an extra `-f` on top of
#     $COMPOSE_FILE (for tests: scripts/test-backup-restore.sh overrides the
#     `app` service with a dependency-free stub image/command, see its own
#     header comment for why).
#
# Why env_get instead of `source .env`: .env is written for docker compose's
# dotenv parser, not for bash. Values such as `SUPERADMIN_TG_IDS=111, 222` or
# `DEFAULT_WORKSPACE_NAME=Some School` are perfectly valid for compose and for
# src/config/env.ts, but `source` word-splits them and tries to run `222` /
# `School` as commands (and would execute `$(...)` inside a value). env_get
# never evaluates anything: it reads one KEY=VALUE line literally, following
# the subset of compose's dotenv rules this project's .env uses:
#   - blank lines and lines starting with `#` are ignored; `export ` prefix ok;
#   - the value is everything after the first `=` (so `=` inside values is
#     kept), leading whitespace removed;
#   - 'single' or "double" quoted values: the text between the quotes,
#     verbatim (no escape processing);
#   - unquoted values: an inline comment starts at whitespace followed by `#`
#     (`KEY=abc  # note` -> `abc`, `KEY=abc#def` -> `abc#def`), trailing
#     whitespace removed;
#   - CRLF line endings tolerated; if a key repeats, the last one wins;
#   - NO `${VAR}` interpolation (compose does interpolate; don't rely on it in
#     values the scripts read -- see docs/DEPLOY.md §8 on POSTGRES_PASSWORD).

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker/compose.yml"
ENV_FILE="${STB_ENV_FILE:-$ROOT_DIR/.env}"
DEPLOY_STATE_DIR="${STB_DEPLOY_STATE_DIR:-$ROOT_DIR/.deploy}"
CURRENT_TAG_FILE="$DEPLOY_STATE_DIR/current_tag"

env_get() {
  local key=$1
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "cannot read $ENV_FILE" >&2
    return 1
  fi
  awk -v key="$key" '
    { sub(/\r$/, "") }
    /^[ \t]*#/ || /^[ \t]*$/ { next }
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      sub(/^export[ \t]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) next
      k = substr(line, 1, eq - 1)
      sub(/[ \t]+$/, "", k)
      if (k != key) next
      v = substr(line, eq + 1)
      sub(/^[ \t]+/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == "\047") {
        rest = substr(v, 2)
        close_at = index(rest, q)
        v = (close_at > 0) ? substr(rest, 1, close_at - 1) : rest
      } else {
        if (match(v, /[ \t]#/)) v = substr(v, 1, RSTART - 1)
        sub(/[ \t]+$/, "", v)
      }
      val = v
    }
    END { printf "%s", val }
  ' "$ENV_FILE"
}

read_current_tag() {
  if [[ -f "$CURRENT_TAG_FILE" ]]; then
    tr -d '[:space:]' < "$CURRENT_TAG_FILE"
  fi
}

compose() {
  local extra_file=()
  if [[ -n "${STB_COMPOSE_EXTRA_FILE:-}" ]]; then
    extra_file=(-f "$STB_COMPOSE_EXTRA_FILE")
  fi
  docker compose -f "$COMPOSE_FILE" "${extra_file[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" "$@"
}
