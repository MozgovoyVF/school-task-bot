#!/usr/bin/env bash
set -euo pipefail

# scripts/compose.sh <docker compose args...>
#
# `docker compose` for this stack (docker/compose.yml, .env, the
# COMPOSE_PROJECT from .env), for manual operations on the VPS:
#
#   ./scripts/compose.sh logs -f app
#   ./scripts/compose.sh ps
#   ./scripts/compose.sh up -d          # e.g. after editing .env
#
# docker/compose.yml requires APP_TAG (no silent `latest` fallback; plan.md
# decision D38). This wrapper takes it from the environment if set, otherwise
# from .deploy/current_tag -- so `up -d` restarts the version that is actually
# deployed. The very first deploy passes it explicitly
# (`APP_TAG=v0.1.0-rc.1 ./scripts/compose.sh up -d`, docs/DEPLOY.md §8).

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

COMPOSE_PROJECT=$(env_get COMPOSE_PROJECT)
if [[ -z "$COMPOSE_PROJECT" ]]; then
  echo "COMPOSE_PROJECT must be set in $ENV_FILE (e.g. stb-dev or stb-prod)" >&2
  exit 1
fi

HTTP_PORT=$(env_get HTTP_PORT)
export HTTP_PORT="${HTTP_PORT:-3000}"

APP_TAG="${APP_TAG:-$(read_current_tag)}"
if [[ -z "$APP_TAG" ]]; then
  echo "APP_TAG is not set and $CURRENT_TAG_FILE does not exist; pass it explicitly: APP_TAG=<tag> $0 $*" >&2
  exit 1
fi
export APP_TAG

compose "$@"
