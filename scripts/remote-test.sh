#!/usr/bin/env bash
#
# Run the smoke test inside the production container.
#
# Usage: scripts/remote-test.sh ["Route Name"]
#
# Exercises the deployed image against live Google Flights, so it validates the
# real production code path rather than a local checkout.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

ROUTE="${1:-}"

require_container

info "Running scripts/test-scrape.js inside '${CONTAINER}'"
if [[ -n "${ROUTE}" ]]; then
  remote_ssh "docker exec ${CONTAINER} node scripts/test-scrape.js $(printf '%q' "${ROUTE}")"
else
  remote_ssh "docker exec ${CONTAINER} node scripts/test-scrape.js"
fi
