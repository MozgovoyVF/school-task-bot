#!/usr/bin/env bash
set -euo pipefail

# scripts/restore.sh <file.age> <identity-file>
#
# Restores an age-encrypted, gzip-compressed pg_dump backup produced by
# scripts/backup.sh: stops the app, drops and recreates the database,
# restores the dump into it, brings the SAME app version back up (the tag
# recorded in .deploy/current_tag, never a floating `latest`; plan.md
# decision D38), and verifies /healthz.
#
# Run from the repo root on the VPS (e.g. /opt/stb-dev or /opt/stb-prod),
# next to docker/compose.yml and .env. See docs/DEPLOY.md §10.
#
# DESTRUCTIVE: this permanently replaces the current database contents.
#
# Reads from .env (see scripts/lib/common.sh -- .env is parsed literally, not
# sourced): POSTGRES_USER, POSTGRES_DB, COMPOSE_PROJECT (required), HTTP_PORT
# (host-side port, default 3000). Also requires .deploy/current_tag.
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
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

HEALTH_TIMEOUT_SECONDS=90
HEALTH_POLL_INTERVAL_SECONDS=3

POSTGRES_USER=$(env_get POSTGRES_USER)
POSTGRES_DB=$(env_get POSTGRES_DB)
COMPOSE_PROJECT=$(env_get COMPOSE_PROJECT)
HTTP_PORT=$(env_get HTTP_PORT)
HTTP_PORT="${HTTP_PORT:-3000}"
export HTTP_PORT

for name in POSTGRES_USER POSTGRES_DB COMPOSE_PROJECT; do
  if [[ -z "${!name}" ]]; then
    echo "$name must be set in $ENV_FILE" >&2
    exit 1
  fi
done

# Bring back exactly the version that was running before the restore.
# Checked before anything is stopped or dropped.
APP_TAG=$(read_current_tag)
if [[ -z "$APP_TAG" ]]; then
  echo "no deployed tag recorded in $CURRENT_TAG_FILE; refusing to guess which app version to start" >&2
  exit 1
fi
export APP_TAG

echo "This will PERMANENTLY REPLACE the contents of database '$POSTGRES_DB' ($COMPOSE_PROJECT)."
echo "The app will be restarted on its current version: $APP_TAG."
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

echo "Starting app ($APP_TAG)..."
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
