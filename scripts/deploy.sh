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

SYNC_FILES=(bot.js scraper.js Dockerfile docker-compose.yml package.json pnpm-lock.yaml)

info "Syncing code to ${SSH_HOST}:${REMOTE_DIR}"
for f in "${SYNC_FILES[@]}"; do
  [[ -f "${REPO_ROOT}/${f}" ]] || die "Missing ${f} in repo root"
  remote_rsync "${REPO_ROOT}/${f}"
  echo "    ${f}"
done

remote_rsync "${REPO_ROOT}/scripts/" "scripts/"
echo "    scripts/"

info "Rebuilding and restarting container"
remote_ssh "cd ${REMOTE_DIR} && docker-compose down && docker-compose build ${BUILD_ARGS[*]:-} && docker-compose up -d"

info "Waiting for startup"
remote_ssh "sleep 8; docker ps --filter name=${CONTAINER} --format 'table {{.Names}}\t{{.Status}}'"

info "Recent log output"
remote_ssh "tail -20 ${REMOTE_DIR}/results.log 2>/dev/null || echo '(results.log empty)'"

info "Deploy complete"
