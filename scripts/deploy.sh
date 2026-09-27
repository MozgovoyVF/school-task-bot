#!/usr/bin/env bash
set -euo pipefail

# scripts/deploy.sh <tag>
#
# Deploys a new app image tag to this compose stack: backs up the database,
# pulls and starts the new image, waits for /healthz, and rolls back to the
# previously deployed tag if the health check never passes.
#
# Run from the repo root on the VPS (e.g. /opt/stb-dev or /opt/stb-prod),
# next to docker/compose.yml and .env. See docs/DEPLOY.md §11.
#
# <tag> must be a concrete release tag (e.g. v0.2.0 or v0.2.0-rc.1), never
# `latest`: it is recorded in .deploy/current_tag as the rollback target for
# the next deploy, and a floating tag would make that target meaningless
# (plan.md decision D38).
#
# Reads from .env (see scripts/lib/common.sh -- .env is parsed literally, not
# sourced): COMPOSE_PROJECT (required, e.g. stb-dev, stb-prod), HTTP_PORT
# (host-side port, default 3000). The scripts/backup.sh call this script makes
# reads its own settings from the same .env.

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

NEW_TAG=$1
if [[ ! "$NEW_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "invalid image tag: $NEW_TAG" >&2
  exit 1
fi
if [[ "$NEW_TAG" == "latest" ]]; then
  echo "refusing to deploy the floating tag 'latest'; pass a concrete release tag (e.g. v0.1.0)" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

HEALTH_TIMEOUT_SECONDS=90
HEALTH_POLL_INTERVAL_SECONDS=3

COMPOSE_PROJECT=$(env_get COMPOSE_PROJECT)
HTTP_PORT=$(env_get HTTP_PORT)
HTTP_PORT="${HTTP_PORT:-3000}"
# Exported so docker compose's own ${HTTP_PORT} substitution (host-side port
# in docker/compose.yml) uses exactly the value this script polls below, even
# if the calling shell happens to export a different HTTP_PORT.
export HTTP_PORT

if [[ -z "$COMPOSE_PROJECT" ]]; then
  echo "COMPOSE_PROJECT must be set in $ENV_FILE (e.g. stb-dev or stb-prod)" >&2
  exit 1
fi

mkdir -p "$DEPLOY_STATE_DIR"

PREVIOUS_TAG=$(read_current_tag)

echo "Previous tag: ${PREVIOUS_TAG:-<none recorded>}"
echo "Deploying tag: $NEW_TAG"

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if curl -fsS "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_POLL_INTERVAL_SECONDS"
  done
  return 1
}

start_tag() {
  local tag=$1
  APP_TAG="$tag" compose pull app
  APP_TAG="$tag" compose up -d
}

echo "Running pre-deploy backup..."
"$SCRIPT_DIR/backup.sh"

echo "Pulling and starting app:$NEW_TAG..."
start_tag "$NEW_TAG"

echo "Waiting for /healthz (up to ${HEALTH_TIMEOUT_SECONDS}s)..."
if wait_for_health; then
  echo "$NEW_TAG" > "$CURRENT_TAG_FILE"
  echo "Deploy succeeded: $NEW_TAG is live."
  exit 0
fi

echo "Health check failed for tag $NEW_TAG." >&2

if [[ -n "$PREVIOUS_TAG" ]]; then
  echo "Rolling back to $PREVIOUS_TAG..." >&2
  start_tag "$PREVIOUS_TAG"
  if wait_for_health; then
    echo "Rollback to $PREVIOUS_TAG succeeded." >&2
  else
    echo "Rollback to $PREVIOUS_TAG ALSO failed the health check. Manual intervention required." >&2
  fi
else
  echo "No previous tag recorded; nothing to roll back to. Manual intervention required." >&2
fi

exit 1
