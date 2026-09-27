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
# Required env (normally set in .env): POSTGRES_USER, POSTGRES_DB, APP_ENV,
# BACKUP_AGE_RECIPIENT, TELEGRAM_BOT_TOKEN, SUPERADMIN_TG_IDS (comma
# separated; the first ID receives the backup/alert), COMPOSE_PROJECT.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker/compose.yml"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_DIR="$ROOT_DIR/backups"
KEEP_COUNT=14
MAX_TELEGRAM_SIZE_BYTES=$((50 * 1024 * 1024))

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${APP_ENV:?APP_ENV must be set}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT must be set}"
: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"
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
  alert_superadmin "school-task-bot backup failed (${APP_ENV}): ${message}"
  exit 1
}

trap 'fail "unexpected error at line ${LINENO}"' ERR

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
