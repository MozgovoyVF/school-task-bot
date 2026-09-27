#!/usr/bin/env bash
set -euo pipefail

# scripts/restore.sh <file.age> <identity-file>
#
# Restores an age-encrypted, gzip-compressed pg_dump backup produced by
# scripts/backup.sh: stops the app, drops and recreates the database,
# restores the dump into it, brings the app back up, and verifies /healthz.
#
# Run from the repo root on the VPS (e.g. /opt/stb-dev or /opt/stb-prod),
# next to docker/compose.yml and .env. See docs/DEPLOY.md §10.
#
# DESTRUCTIVE: this permanently replaces the current database contents.
#
# Required env (normally set in .env, which this script sources itself from
# its own directory -- see below): POSTGRES_USER, POSTGRES_DB,
# COMPOSE_PROJECT. Optional: HTTP_PORT (default 3000).
#
# <identity-file> is the age private key file matching the public key
# (BACKUP_AGE_RECIPIENT) the backup was encrypted with; it is kept off the
# server, so it must be copied in (e.g. scp) before running this script.

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <file.age> <identity-file>" >&2
  exit 1
fi

BACKUP_FILE=$1
IDENTITY_FILE=$2

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "backup file not found: $BACKUP_FILE" >&2
  exit 1
fi
if [[ ! -f "$IDENTITY_FILE" ]]; then
  echo "identity file not found: $IDENTITY_FILE" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker/compose.yml"
ENV_FILE="$ROOT_DIR/.env"
HEALTH_TIMEOUT_SECONDS=90
HEALTH_POLL_INTERVAL_SECONDS=3

# Load config from .env next to this script's repo root, so a bare
# `./scripts/restore.sh <file> <identity>` works without the caller having
# to export anything first. Values already exported in the calling shell
# are overridden by .env, which is the intended single source of truth for
# this stack's config.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

HTTP_PORT="${HTTP_PORT:-3000}"

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" "$@"
}

echo "This will PERMANENTLY REPLACE the contents of database '$POSTGRES_DB' ($COMPOSE_PROJECT)."
read -r -p "Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo "Stopping app..."
compose stop app

echo "Recreating database..."
# Terminate any stray backends first (app is stopped, but a leftover manual
# psql session etc. would otherwise make DROP DATABASE fail with "database
# is being accessed by other users").
compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";" \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

echo "Restoring backup from $BACKUP_FILE..."
age -d -i "$IDENTITY_FILE" "$BACKUP_FILE" \
  | gunzip \
  | compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Starting app..."
compose up -d app

echo "Waiting for /healthz (up to ${HEALTH_TIMEOUT_SECONDS}s)..."
DEADLINE=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until curl -fsS "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; do
  if (( SECONDS >= DEADLINE )); then
    echo "app did not become healthy after restore" >&2
    exit 1
  fi
  sleep "$HEALTH_POLL_INTERVAL_SECONDS"
done

echo "Restore complete; app is healthy."
