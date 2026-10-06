#!/usr/bin/env bash
set -euo pipefail

# scripts/test-backup-restore.sh
#
# Exercises the real scripts/backup.sh and scripts/restore.sh, end to end,
# entirely in Docker, against a throwaway fixture -- no real server, real
# crontab or real Telegram bot is touched (plan.md Task 4.1, step 1).
#
#   1. Starts a temporary Postgres 17 (compose project A) and loads a small
#      synthetic fixture (a few tables, a few rows each -- this test proves
#      the backup/restore MECHANISM round-trips faithfully, not the app's
#      own Drizzle schema, so it doesn't run migrations).
#   2. Runs scripts/backup.sh against it with a throwaway age key.
#   3. Starts a second temporary Postgres (compose project B) and restores
#      the backup into it via scripts/restore.sh.
#   4. Compares `count(*)` on every table between A (pre-backup) and B
#      (post-restore); any mismatch fails the script.
#   5. Deliberately corrupts a copy of the backup (strips one table's data)
#      and restores THAT into B too, asserting the count comparison catches
#      it -- i.e. that step 4's check actually detects a bad restore, not
#      just that happy-path restores happen to match. B is then torn down
#      and nothing from this step is kept.
#
# Both compose projects use docker/compose.yml's real `db` service, so
# backup.sh/restore.sh exercise their real `pg_dump`/`psql` paths. Their
# `app` service is overridden (via STB_COMPOSE_EXTRA_FILE, see
# scripts/lib/common.sh) to a trivial busybox httpd that only answers
# /healthz -- the real app image needs a working Telegram Bot API token at
# startup (grammY's bot.init() calls getMe before /healthz is ever served),
# and CLAUDE.md forbids this test from making real Telegram API calls or
# depending on one; the stub keeps restore.sh's actual /healthz-wait logic
# exercised against a real container without that dependency.
#
# backup.sh's own happy-path Telegram call (sendDocument, forwarding the
# backup to the superadmin) is NOT one `alert_superadmin` swallows -- a real
# fake token would make backup.sh itself fail with a 401. So this script
# also starts a tiny local HTTP stub (plain Node, 127.0.0.1 only) that
# answers every request with `{"ok":true}` and points backup.sh at it via
# STB_TELEGRAM_API_BASE, instead of the real Bot API.
#
# Everything lives under a throwaway TMPDIR and repo-root-independent
# overrides (STB_ENV_FILE, STB_DEPLOY_STATE_DIR, STB_BACKUP_DIR,
# STB_COMPOSE_EXTRA_FILE, STB_TELEGRAM_API_BASE -- all "for tests" knobs in
# scripts/lib/common.sh and scripts/backup.sh): this script never reads or
# writes this repo's real .env, .deploy/, or backups/, and never calls the
# real Telegram Bot API.
#
# Requires: docker, age/age-keygen, curl, node. Run from the repo root:
#   ./scripts/test-backup-restore.sh

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

for bin in docker age age-keygen curl node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing required tool: $bin" >&2
    exit 1
  fi
done

RUN_ID="stbtest$$"
PROJECT_A="${RUN_ID}a"
PROJECT_B="${RUN_ID}b"
TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")
HTTP_PORT_A=31801
HTTP_PORT_B=31802
TELEGRAM_STUB_PORT=31900
TELEGRAM_STUB_PID=""

log() { echo "[test-backup-restore] $*"; }

cleanup() {
  local status=$?
  log "cleaning up..."
  if [[ -n "$TELEGRAM_STUB_PID" ]]; then
    kill "$TELEGRAM_STUB_PID" >/dev/null 2>&1 || true
    wait "$TELEGRAM_STUB_PID" 2>/dev/null || true
  fi
  STB_ENV_FILE="$TMPDIR/a.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
    STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-a.yml" \
    COMPOSE_PROJECT="$PROJECT_A" "$SCRIPT_DIR/compose.sh" down -v --remove-orphans >/dev/null 2>&1 || true
  STB_ENV_FILE="$TMPDIR/b.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
    STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-b.yml" \
    COMPOSE_PROJECT="$PROJECT_B" "$SCRIPT_DIR/compose.sh" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
  if [[ $status -eq 0 ]]; then
    log "PASS"
  else
    log "FAIL (exit $status)"
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$TMPDIR/deploy-state" "$TMPDIR/backups"
echo -n "test" >"$TMPDIR/deploy-state/current_tag"

# --- local Telegram Bot API stub (127.0.0.1 only; see header comment) -------
node -e '
  const http = require("node:http");
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: true }));
  }).listen(process.argv[1], "127.0.0.1");
' "$TELEGRAM_STUB_PORT" &
TELEGRAM_STUB_PID=$!
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${TELEGRAM_STUB_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# --- throwaway age identity -------------------------------------------------
age-keygen -o "$TMPDIR/identity.txt" 2>"$TMPDIR/age-keygen.log"
AGE_RECIPIENT=$(grep '^# public key:' "$TMPDIR/identity.txt" | sed 's/^# public key: //')
if [[ -z "$AGE_RECIPIENT" ]]; then
  echo "could not extract a public key from age-keygen output" >&2
  exit 1
fi

# --- stub app image (no Telegram/DB dependency, just /healthz) -------------
STUB_IMAGE="stb-test-app-stub:$RUN_ID"
mkdir -p "$TMPDIR/stub-app"
cat >"$TMPDIR/stub-app/Dockerfile" <<'EOF'
FROM busybox:latest
RUN mkdir -p /www && echo ok >/www/healthz
EXPOSE 3000
CMD ["httpd", "-f", "-v", "-p", "3000", "-h", "/www"]
EOF
docker build -q -t "$STUB_IMAGE" "$TMPDIR/stub-app" >/dev/null

# --- throwaway .env files ----------------------------------------------------
write_env() {
  local path=$1 project=$2 http_port=$3
  cat >"$path" <<EOF
APP_ENV=dev
COMPOSE_PROJECT=${project}
POSTGRES_USER=stb_test
POSTGRES_PASSWORD=stb_test
POSTGRES_DB=stb_test
HTTP_PORT=${http_port}
TELEGRAM_BOT_TOKEN=000000:TEST-FAKE-TOKEN-NOT-REAL
SUPERADMIN_TG_IDS=100000001
BACKUP_AGE_RECIPIENT=${AGE_RECIPIENT}
EOF
}
write_env "$TMPDIR/a.env" "$PROJECT_A" "$HTTP_PORT_A"
write_env "$TMPDIR/b.env" "$PROJECT_B" "$HTTP_PORT_B"

# docker/compose.yml's `env_file: ../.env` is a path fixed relative to that
# compose file, so `docker compose --env-file` alone (which only feeds
# ${VAR} interpolation inside the compose YAML, not a service's own
# `env_file:` directive) would leave `db`/`app` loading the REAL repo .env.
# The override below replaces `env_file` with this stack's own throwaway
# env, on top of swapping `app`'s image for the dependency-free stub.
write_override() {
  local path=$1 env_file=$2
  cat >"$path" <<EOF
services:
  app:
    image: ${STUB_IMAGE}
    env_file: ${env_file}
  db:
    env_file: ${env_file}
EOF
}
write_override "$TMPDIR/override-a.yml" "$TMPDIR/a.env"
write_override "$TMPDIR/override-b.yml" "$TMPDIR/b.env"

compose_a() {
  STB_ENV_FILE="$TMPDIR/a.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
    STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-a.yml" \
    COMPOSE_PROJECT="$PROJECT_A" HTTP_PORT="$HTTP_PORT_A" "$SCRIPT_DIR/compose.sh" "$@"
}
compose_b() {
  STB_ENV_FILE="$TMPDIR/b.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
    STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-b.yml" \
    COMPOSE_PROJECT="$PROJECT_B" HTTP_PORT="$HTTP_PORT_B" "$SCRIPT_DIR/compose.sh" "$@"
}

wait_db_healthy() {
  local compose_fn=$1 deadline=$((SECONDS + 60)) cid status
  until
    cid=$($compose_fn ps -q db)
    [[ -n "$cid" ]] &&
      status=$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null) &&
      [[ "$status" == "healthy" ]]
  do
    if (( SECONDS >= deadline )); then
      echo "db never became healthy" >&2
      exit 1
    fi
    sleep 2
  done
}

# --- fixture ------------------------------------------------------------------
FIXTURE_TABLES=(widgets gadgets)

log "starting source stack ($PROJECT_A)..."
compose_a up -d db app
wait_db_healthy compose_a

log "loading fixture..."
compose_a exec -T db psql -U stb_test -d stb_test >/dev/null <<'SQL'
CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL, note text);
INSERT INTO widgets (name, note) VALUES ('alpha', 'тест 1'), ('beta', NULL), ('gamma', 'тест 3');
CREATE TABLE gadgets (id serial PRIMARY KEY, widget_id integer REFERENCES widgets(id));
INSERT INTO gadgets (widget_id) VALUES (1), (1), (2);
SQL

count_tables() {
  local compose_fn=$1
  for table in "${FIXTURE_TABLES[@]}"; do
    local count
    count=$($compose_fn exec -T db psql -U stb_test -d stb_test -t -A -c "select count(*) from ${table};")
    echo "${table}=${count}"
  done
}

EXPECTED_COUNTS=$(count_tables compose_a)
log "fixture counts: $(echo "$EXPECTED_COUNTS" | tr '\n' ' ')"

# --- backup -------------------------------------------------------------------
log "running backup.sh..."
STB_ENV_FILE="$TMPDIR/a.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
  STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-a.yml" STB_BACKUP_DIR="$TMPDIR/backups" \
  STB_TELEGRAM_API_BASE="http://127.0.0.1:${TELEGRAM_STUB_PORT}" \
  "$SCRIPT_DIR/backup.sh"

BACKUP_FILE=$(ls -t "$TMPDIR/backups"/stb-dev-*.sql.gz.age | head -n1)
if [[ -z "$BACKUP_FILE" ]]; then
  echo "backup.sh did not produce a backup file" >&2
  exit 1
fi
log "backup written: $BACKUP_FILE"

# --- restore (good backup) ----------------------------------------------------
log "starting target stack ($PROJECT_B)..."
compose_b up -d db app
wait_db_healthy compose_b

log "running restore.sh (good backup)..."
echo yes | STB_ENV_FILE="$TMPDIR/b.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
  STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-b.yml" \
  "$SCRIPT_DIR/restore.sh" "$BACKUP_FILE" "$TMPDIR/identity.txt"

ACTUAL_COUNTS=$(count_tables compose_b)
if [[ "$ACTUAL_COUNTS" != "$EXPECTED_COUNTS" ]]; then
  echo "restore round-trip mismatch:" >&2
  echo "expected: $EXPECTED_COUNTS" >&2
  echo "actual:   $ACTUAL_COUNTS" >&2
  exit 1
fi
log "round-trip counts match."

# --- failure-mode check: a dump missing a table's data must be caught --------
log "checking that a corrupted dump is detected (removing gadgets' data)..."
age -d -i "$TMPDIR/identity.txt" "$BACKUP_FILE" | gunzip >"$TMPDIR/good.sql"
awk '
  /^COPY public\.gadgets /  { skipping = 1; next }
  skipping && /^\\\.$/      { skipping = 0; next }
  skipping                 { next }
  { print }
' "$TMPDIR/good.sql" >"$TMPDIR/corrupted.sql"
if diff -q "$TMPDIR/good.sql" "$TMPDIR/corrupted.sql" >/dev/null; then
  echo "corruption step did not change the dump; failure-mode check cannot run" >&2
  exit 1
fi
gzip -c "$TMPDIR/corrupted.sql" | age -r "$AGE_RECIPIENT" >"$TMPDIR/corrupted.sql.gz.age"

log "restoring the corrupted dump into $PROJECT_B (expected to end up short on data)..."
echo yes | STB_ENV_FILE="$TMPDIR/b.env" STB_DEPLOY_STATE_DIR="$TMPDIR/deploy-state" \
  STB_COMPOSE_EXTRA_FILE="$TMPDIR/override-b.yml" \
  "$SCRIPT_DIR/restore.sh" "$TMPDIR/corrupted.sql.gz.age" "$TMPDIR/identity.txt"

CORRUPTED_COUNTS=$(count_tables compose_b)
if [[ "$CORRUPTED_COUNTS" == "$EXPECTED_COUNTS" ]]; then
  echo "failure-mode check did not detect the corrupted restore -- the count comparison is not reliable" >&2
  exit 1
fi
log "corrupted restore correctly detected as mismatched: $(echo "$CORRUPTED_COUNTS" | tr '\n' ' ')"

log "all checks passed; tearing down (cleanup trap)."
