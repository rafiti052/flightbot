#!/usr/bin/env bash
#
# Deploy flightbot code to EC2 and restart the container.
#
# Usage: scripts/deploy.sh [--no-cache]
#
# Never syncs config.json / prices.json / results.log — those are live server
# state, bind-mounted into the container.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

BUILD_ARGS=()
case "${1:-}" in
  --no-cache) BUILD_ARGS+=(--no-cache) ;;
  "")         ;;
  *)          die "usage: $(basename "$0") [--no-cache]" ;;
esac

SYNC_FILES=(bot.ts scraper.ts ui.ts types.ts Dockerfile .dockerignore docker-compose.yml package.json pnpm-lock.yaml pnpm-workspace.yaml)
DEPLOY_STARTED_AT="$(date +%s)"

step "1/4 Syncing code to ${SSH_HOST}:${REMOTE_DIR}"
STEP_STARTED_AT="$(date +%s)"
for f in "${SYNC_FILES[@]}"; do
  [[ -f "${REPO_ROOT}/${f}" ]] || die "Missing ${f} in repo root"
  remote_rsync "${REPO_ROOT}/${f}"
  detail "${f}"
done

remote_rsync "${REPO_ROOT}/scripts/" "scripts/"
detail "scripts/"
detail "completed in $(( $(date +%s) - STEP_STARTED_AT ))s"

step "2/4 Rebuilding and restarting container"
STEP_STARTED_AT="$(date +%s)"
remote_ssh "cd ${REMOTE_DIR} && docker-compose down && docker-compose build ${BUILD_ARGS[*]:-} && docker-compose up -d"
detail "completed in $(( $(date +%s) - STEP_STARTED_AT ))s"

step "3/4 Waiting for startup"
STEP_STARTED_AT="$(date +%s)"
CONTAINER_STATUS="$(remote_ssh "sleep 8; docker ps --filter name=${CONTAINER} --format '{{.Names}}\t{{.Status}}'")"
[[ -n "${CONTAINER_STATUS}" ]] || die "Container '${CONTAINER}' did not come back up"
detail "${CONTAINER_STATUS}"
detail "completed in $(( $(date +%s) - STEP_STARTED_AT ))s"

step "4/4 Recent log output"
STEP_STARTED_AT="$(date +%s)"
remote_ssh "tail -20 ${REMOTE_DIR}/results.log 2>/dev/null || echo '(results.log empty)'"
detail "completed in $(( $(date +%s) - STEP_STARTED_AT ))s"

DEPLOY_SECONDS="$(( $(date +%s) - DEPLOY_STARTED_AT ))"
ok "deployed in ${DEPLOY_SECONDS}s · ${CONTAINER_STATUS}"
