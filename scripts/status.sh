#!/usr/bin/env bash
#
# Report flightbot operational status: container health, last run, issues.
#
# Usage: scripts/status.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

[[ $# -eq 0 ]] || die "usage: $(basename "$0")"

info "Container"
remote_ssh "docker ps -a --filter name=${CONTAINER} --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'"

info "Last run"
remote_ssh "grep -E '=== Bot run (started|complete) ===' ${REMOTE_DIR}/results.log 2>/dev/null | tail -4 || echo '(no completed runs in results.log)'"

info "Best prices seen"
remote_ssh "grep -E 'Best price:' ${REMOTE_DIR}/results.log 2>/dev/null | tail -10 || echo '(none)'"

info "Issues (errors / timeouts / empty results)"
remote_ssh "grep -icE 'error|failed|Timed out|Found 0 result' ${REMOTE_DIR}/results.log 2>/dev/null || echo 0" \
  | { read -r count; echo "    ${count} matching line(s) total"; }
remote_ssh "grep -iE 'error|failed|Timed out|Found 0 result' ${REMOTE_DIR}/results.log 2>/dev/null | tail -15 || echo '(none)'"

info "Live prices.json"
remote_ssh "cat ${REMOTE_DIR}/prices.json 2>/dev/null || echo '(missing)'"
