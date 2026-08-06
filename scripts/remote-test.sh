#!/usr/bin/env bash
#
# Run the smoke test inside the production container.
#
# Usage: scripts/remote-test.sh ["Route Name"] [--json] [--no-send] [-v]
#
# Exercises the deployed image against live Google Flights, so it validates the
# real production code path rather than a local checkout.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_container

step "Running scripts/test-scrape.ts inside '${CONTAINER}'"
REMOTE_COMMAND="docker exec $(printf '%q' "${CONTAINER}") pnpm exec tsx scripts/test-scrape.ts"
for arg in "$@"; do
  REMOTE_COMMAND+=" $(printf '%q' "${arg}")"
done
remote_ssh "${REMOTE_COMMAND}"
