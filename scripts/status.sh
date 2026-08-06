#!/usr/bin/env bash
#
# Report flightbot operational status: container health, last run, issues.
#
# Usage: scripts/status.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

[[ $# -eq 0 ]] || die "usage: $(basename "$0")"

remote_ssh "
echo __CONTAINER__
docker ps -a --filter name=${CONTAINER} --format '{{.Names}}\t{{.Status}}\t{{.RunningFor}}'
echo __RUNS__
grep -E '=== Bot run (started|complete) ===' ${REMOTE_DIR}/results.log 2>/dev/null | tail -20 || true
echo __BEST__
grep -E 'Best price:' ${REMOTE_DIR}/results.log 2>/dev/null | tail -200 || true
echo __ISSUE_COUNT__
grep -icE '${ISSUE_PATTERN}' ${REMOTE_DIR}/results.log 2>/dev/null || true
echo __ISSUES__
grep -iE '${ISSUE_PATTERN}' ${REMOTE_DIR}/results.log 2>/dev/null | tail -30 || true
echo __PRICES__
cat ${REMOTE_DIR}/prices.json 2>/dev/null || echo '{}'
echo __END__
" | pnpm exec tsx "${REPO_ROOT}/scripts/lib/format-status.ts"
