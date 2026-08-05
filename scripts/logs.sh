#!/usr/bin/env bash
#
# Print flightbot logs.
#
# Usage:
#   scripts/logs.sh                 # local results.log
#   scripts/logs.sh --remote [N]    # last N lines of the server log (default 60)
#   scripts/logs.sh --docker [N]    # container stdout (survives results.log loss)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MODE="${1:-local}"
LINES="${2:-60}"

case "${MODE}" in
  local)
    LOG="${REPO_ROOT}/results.log"
    [[ -f "${LOG}" ]] || die "No local results.log at ${LOG}"
    info "Local results.log (${LOG})"
    cat "${LOG}"
    ;;
  --remote)
    info "Remote results.log (last ${LINES})"
    remote_ssh "tail -${LINES} ${REMOTE_DIR}/results.log 2>/dev/null || echo '(results.log missing or empty)'"
    ;;
  --docker)
    info "Container stdout (last ${LINES})"
    remote_ssh "docker logs --tail ${LINES} ${CONTAINER} 2>&1"
    ;;
  *)
    die "usage: $(basename "$0") [--remote|--docker] [lines]"
    ;;
esac
