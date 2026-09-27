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
# Reads from .env (see scripts/lib/common.sh -- .env is parsed literally, not
# sourced, so values like `SUPERADMIN_TG_IDS=111, 222` are fine):
# POSTGRES_USER, POSTGRES_DB, APP_ENV, BACKUP_AGE_RECIPIENT,
# TELEGRAM_BOT_TOKEN, SUPERADMIN_TG_IDS (comma separated; the first ID
# receives the backup/alert), COMPOSE_PROJECT. Also needs the currently
# deployed tag in .deploy/current_tag (docker/compose.yml requires APP_TAG
# for every compose command, even `exec db`; plan.md decision D38) unless
# APP_TAG is already set by the caller.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

BACKUP_DIR="$ROOT_DIR/backups"
KEEP_COUNT=14
MAX_TELEGRAM_SIZE_BYTES=$((50 * 1024 * 1024))

# The alert path is installed FIRST, before anything is read from .env, so
# that every later failure -- an unreadable .env, a missing variable, a
# failed pg_dump -- goes through fail() and reaches the superadmin. The only
# failures that cannot alert are those that leave us without the alert
# credentials themselves (no readable .env, or no TELEGRAM_BOT_TOKEN /
# SUPERADMIN_TG_IDS in it): then the message only reaches stderr / the cron
# log, because there is nobody we know how to tell.
TELEGRAM_BOT_TOKEN=""
SUPERADMIN_ID=""
APP_ENV=""

alert_superadmin() {
  local message=$1
  if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$SUPERADMIN_ID" ]]; then
    echo "(no TELEGRAM_BOT_TOKEN/SUPERADMIN_TG_IDS available; Telegram alert not sent)" >&2
    return 0
  fi
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
    fail "$name must be set in $ENV_FILE"
  fi
}

# Alert credentials first, so every check below can alert.
TELEGRAM_BOT_TOKEN=$(env_get TELEGRAM_BOT_TOKEN)
SUPERADMIN_TG_IDS=$(env_get SUPERADMIN_TG_IDS)
# First ID from the comma-separated list receives backups and alerts.
SUPERADMIN_ID="${SUPERADMIN_TG_IDS%%,*}"
SUPERADMIN_ID="${SUPERADMIN_ID//[[:space:]]/}"
require_env TELEGRAM_BOT_TOKEN
require_env SUPERADMIN_TG_IDS

APP_ENV=$(env_get APP_ENV)
POSTGRES_USER=$(env_get POSTGRES_USER)
POSTGRES_DB=$(env_get POSTGRES_DB)
BACKUP_AGE_RECIPIENT=$(env_get BACKUP_AGE_RECIPIENT)
COMPOSE_PROJECT=$(env_get COMPOSE_PROJECT)

require_env APP_ENV
require_env POSTGRES_USER
require_env POSTGRES_DB
require_env BACKUP_AGE_RECIPIENT
require_env COMPOSE_PROJECT

APP_TAG="${APP_TAG:-$(read_current_tag)}"
if [[ -z "$APP_TAG" ]]; then
  fail "no deployed tag recorded in $CURRENT_TAG_FILE (deploy the app first, docs/DEPLOY.md §8)"
fi
export APP_TAG

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
# A read loop instead of `mapfile`: mapfile is bash 4+, and macOS ships bash 3.2.
OLD_BACKUPS=()
while IFS= read -r old_backup; do
  OLD_BACKUPS+=("$old_backup")
done < <(ls -1t "$BACKUP_DIR"/stb-"${APP_ENV}"-*.sql.gz.age 2>/dev/null | tail -n "+$((KEEP_COUNT + 1))")
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
