#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/docker.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example before deploying." >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

export FLIGHTBOT_DATA_DIR="${FLIGHTBOT_DATA_DIR:-/data}"
export FLIGHTBOT_HOST_DATA_DIR="${FLIGHTBOT_HOST_DATA_DIR:-${REPO_ROOT}/.flightbot/docker}"

mkdir -p "${FLIGHTBOT_HOST_DATA_DIR}"
touch "${FLIGHTBOT_HOST_DATA_DIR}/results.log"

if [[ ! -f "${FLIGHTBOT_HOST_DATA_DIR}/prices.json" ]]; then
  printf '{}\n' > "${FLIGHTBOT_HOST_DATA_DIR}/prices.json"
fi

cd "${REPO_ROOT}"
exec docker compose up -d --build
