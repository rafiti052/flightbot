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

if [[ -z "${FLIGHTBOT_DATA_DIR:-}" ]]; then
  export FLIGHTBOT_DATA_DIR="${REPO_ROOT}"
  echo "FLIGHTBOT_DATA_DIR is unset in ${ENV_FILE}; using local repo-root fallback: ${FLIGHTBOT_DATA_DIR}" >&2
elif [[ "${FLIGHTBOT_DATA_DIR}" != /* ]]; then
  export FLIGHTBOT_DATA_DIR="${REPO_ROOT}/${FLIGHTBOT_DATA_DIR#./}"
fi

mkdir -p "${FLIGHTBOT_DATA_DIR}"
export FLIGHTBOT_DATA_DIR="$(cd "${FLIGHTBOT_DATA_DIR}" && pwd)"
touch "${FLIGHTBOT_DATA_DIR}/results.log"

if [[ ! -f "${FLIGHTBOT_DATA_DIR}/prices.json" ]]; then
  printf '{}\n' > "${FLIGHTBOT_DATA_DIR}/prices.json"
fi

if [[ ! -f "${FLIGHTBOT_DATA_DIR}/config.yml" && ! -f "${FLIGHTBOT_DATA_DIR}/config.json" ]]; then
  echo "Missing ${FLIGHTBOT_DATA_DIR}/config.yml (or legacy config.json). Point FLIGHTBOT_DATA_DIR at your runtime data dir in ${ENV_FILE}." >&2
  exit 1
fi

cd "${REPO_ROOT}"
exec node apps/bot/bot.js
