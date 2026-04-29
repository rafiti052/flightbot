#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/bot.env.local"
EXTERNAL_PORT="${PORT-}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example before starting the bot." >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

if [[ -n "${EXTERNAL_PORT}" ]]; then
  export PORT="${EXTERNAL_PORT}"
fi

export FLIGHTBOT_DATA_DIR="${FLIGHTBOT_DATA_DIR:-${REPO_ROOT}}"
mkdir -p "${FLIGHTBOT_DATA_DIR}"
touch "${FLIGHTBOT_DATA_DIR}/results.log"

if [[ ! -f "${FLIGHTBOT_DATA_DIR}/prices.json" ]]; then
  printf '{}\n' > "${FLIGHTBOT_DATA_DIR}/prices.json"
fi

cd "${REPO_ROOT}"
exec node apps/bot/bot.js
