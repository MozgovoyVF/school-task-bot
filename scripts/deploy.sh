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
# Required env (normally set in .env, sourced by the caller or exported
# before running this script): COMPOSE_PROJECT (e.g. stb-dev, stb-prod).
# Optional: HTTP_PORT (default 3000).
#
# The scripts/backup.sh call this script makes needs its own required env;
# see that script's header.

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

NEW_TAG=$1
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker/compose.yml"
ENV_FILE="$ROOT_DIR/.env"
DEPLOY_STATE_DIR="$ROOT_DIR/.deploy"
CURRENT_TAG_FILE="$DEPLOY_STATE_DIR/current_tag"
HTTP_PORT="${HTTP_PORT:-3000}"
HEALTH_TIMEOUT_SECONDS=90
HEALTH_POLL_INTERVAL_SECONDS=3

: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set (e.g. stb-dev or stb-prod)}"

mkdir -p "$DEPLOY_STATE_DIR"

PREVIOUS_TAG=""
if [[ -f "$CURRENT_TAG_FILE" ]]; then
  PREVIOUS_TAG=$(cat "$CURRENT_TAG_FILE")
fi

echo "Previous tag: ${PREVIOUS_TAG:-<none recorded>}"
echo "Deploying tag: $NEW_TAG"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" "$@"
}

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
