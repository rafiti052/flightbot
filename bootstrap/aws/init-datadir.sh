#!/usr/bin/env bash
# Initialize a fresh host-owned runtime directory on a new host (e.g. AWS EC2).
# Usage: ./init-datadir.sh [/opt/flightbot/data]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${1:-/opt/flightbot/data}"

mkdir -p "${DATA_DIR}/.flightbot"

if [[ -f "${DATA_DIR}/config.yml" ]]; then
  echo "config.yml already exists — leaving it untouched."
else
  cp "${SCRIPT_DIR}/config.yml.example" "${DATA_DIR}/config.yml"
  echo "Created ${DATA_DIR}/config.yml from template."
  echo "Edit it now: set anthropic.apiKey, telegram.token, telegram.chatId, and routes."
fi

if [[ -f "${DATA_DIR}/prices.json" ]]; then
  echo "prices.json already exists — leaving it untouched."
else
  cp "${SCRIPT_DIR}/prices.json.example" "${DATA_DIR}/prices.json"
  echo "Created empty ${DATA_DIR}/prices.json"
fi

if [[ ! -f "${DATA_DIR}/results.log" ]]; then
  : > "${DATA_DIR}/results.log"
  echo "Created empty ${DATA_DIR}/results.log"
fi

echo "Done. Optional: after first bot run, ${DATA_DIR}/.flightbot/last-run.json will appear."
echo "This directory is host-owned runtime state, not part of the repo checkout."
echo "For Docker/AWS deploys, set:"
echo "  FLIGHTBOT_HOST_DATA_DIR=${DATA_DIR}"
echo "  FLIGHTBOT_DATA_DIR=/data"
echo "Then mount the host path at /data inside the container."
