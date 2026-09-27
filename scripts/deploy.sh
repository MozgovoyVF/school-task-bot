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
# Required env (normally set in .env, which this script sources itself from
# its own directory -- see below): COMPOSE_PROJECT (e.g. stb-dev, stb-prod).
# Optional: HTTP_PORT (default 3000).
#
# The scripts/backup.sh call this script makes needs its own required env;
# see that script's header (it sources the same .env itself too).

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
HEALTH_TIMEOUT_SECONDS=90
HEALTH_POLL_INTERVAL_SECONDS=3

# Load config from .env next to this script's repo root, so a bare
# `./scripts/deploy.sh <tag>` (from a human or the deploy.yml GitHub Action)
# works without the caller having to export anything first. Values already
# exported in the calling shell are overridden by .env, which is the
# intended single source of truth for this stack's config.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

HTTP_PORT="${HTTP_PORT:-3000}"

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
