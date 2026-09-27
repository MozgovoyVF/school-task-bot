#!/usr/bin/env bash
set -euo pipefail

# scripts/backup.sh
#
# Dumps the app's Postgres database, compresses it, encrypts it with age,
# keeps the 14 most recent backups on disk, and forwards the encrypted file
# to the superadmin over Telegram when it is small enough. On any failure it
# alerts the superadmin with a plain-text message instead and exits 1.
#
# Run from the repo root on the VPS (e.g. /opt/stb-dev or /opt/stb-prod),
# next to docker/compose.yml and .env. See docs/DEPLOY.md §10.
#
# Required env (normally set in .env, which this script sources itself from
# its own directory -- see below): POSTGRES_USER, POSTGRES_DB, APP_ENV,
# BACKUP_AGE_RECIPIENT, TELEGRAM_BOT_TOKEN, SUPERADMIN_TG_IDS (comma
# separated; the first ID receives the backup/alert), COMPOSE_PROJECT.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker/compose.yml"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_DIR="$ROOT_DIR/backups"
KEEP_COUNT=14
MAX_TELEGRAM_SIZE_BYTES=$((50 * 1024 * 1024))

# Load config from .env next to this script's repo root, so a bare
# `./scripts/backup.sh` (from cron or a human) works without the caller
# having to export anything first. Values already exported in the calling
# shell are overridden by .env, which is the intended single source of
# truth for this stack's config.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# TELEGRAM_BOT_TOKEN and SUPERADMIN_TG_IDS are needed by the alert path
# itself (alert_superadmin/fail, below) -- if either is missing there is no
# way to alert about it, so these two are checked directly via bash's
# ${VAR:?msg}. Every other required var is checked further down through
# require_env(), AFTER the trap is installed: ${VAR:?msg} is a parameter-
# expansion error that exits the shell directly and does NOT invoke an
# already-installed ERR trap (verified empirically), so it would silently
# skip the Telegram alert for a misconfigured POSTGRES_USER etc. if used
# here. require_env() instead calls fail() as an ordinary function call,
# which does go through the alert path.
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN must be set}"
: "${SUPERADMIN_TG_IDS:?SUPERADMIN_TG_IDS must be set}"

# First ID from the comma-separated list receives backups and alerts.
SUPERADMIN_ID="${SUPERADMIN_TG_IDS%%,*}"
SUPERADMIN_ID="${SUPERADMIN_ID// /}"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" "$@"
}

alert_superadmin() {
  local message=$1
  curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${SUPERADMIN_ID}" \
    --data-urlencode "text=${message}" \
    >/dev/null 2>&1 || true
}

fail() {
  local message=$1
  trap - ERR
  echo "$message" >&2
  alert_superadmin "school-task-bot backup failed (${APP_ENV:-unknown}): ${message}"
  exit 1
}

trap 'fail "unexpected error at line ${LINENO}"' ERR

require_env() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    fail "$name must be set"
  fi
}

require_env POSTGRES_USER
require_env POSTGRES_DB
require_env APP_ENV
require_env BACKUP_AGE_RECIPIENT
require_env COMPOSE_PROJECT

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_FILE="$BACKUP_DIR/stb-${APP_ENV}-${TIMESTAMP}.sql.gz.age"

compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  > "$OUT_FILE"

if [[ ! -s "$OUT_FILE" ]]; then
  fail "backup file $OUT_FILE is empty"
fi

echo "Backup written: $OUT_FILE"

# Keep only the KEEP_COUNT most recent backups for this environment.
mapfile -t OLD_BACKUPS < <(ls -1t "$BACKUP_DIR"/stb-"${APP_ENV}"-*.sql.gz.age 2>/dev/null | tail -n "+$((KEEP_COUNT + 1))")
if [[ ${#OLD_BACKUPS[@]} -gt 0 ]]; then
  echo "Pruning ${#OLD_BACKUPS[@]} old backup(s)..."
  rm -f -- "${OLD_BACKUPS[@]}"
fi

FILE_SIZE=$(stat -c%s "$OUT_FILE" 2>/dev/null || stat -f%z "$OUT_FILE")

if (( FILE_SIZE <= MAX_TELEGRAM_SIZE_BYTES )); then
  curl -fsS -F document=@"$OUT_FILE" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument?chat_id=${SUPERADMIN_ID}" \
    >/dev/null
  echo "Backup sent to superadmin via Telegram."
else
  echo "Backup file exceeds 50MB (${FILE_SIZE} bytes); kept on server only, not sent via Telegram."
fi
