#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/docker.env"
DEFAULT_CONTAINER_DATA_DIR="/data"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example before deploying." >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

export FLIGHTBOT_DATA_DIR="${FLIGHTBOT_DATA_DIR:-${DEFAULT_CONTAINER_DATA_DIR}}"

if [[ -z "${FLIGHTBOT_HOST_DATA_DIR:-}" ]]; then
  cat >&2 <<EOF
FLIGHTBOT_HOST_DATA_DIR must be set in ${ENV_FILE} (or the shell environment) before deploy.
Use a host-owned directory outside the repo checkout, for example:

  FLIGHTBOT_HOST_DATA_DIR=/opt/flightbot/data
  FLIGHTBOT_DATA_DIR=${DEFAULT_CONTAINER_DATA_DIR}

Bootstrap that host directory first with:
  ${REPO_ROOT}/bootstrap/aws/init-datadir.sh /opt/flightbot/data
EOF
  exit 1
fi

if [[ "${FLIGHTBOT_HOST_DATA_DIR}" != /* ]]; then
  echo "FLIGHTBOT_HOST_DATA_DIR must be an absolute host path, got: ${FLIGHTBOT_HOST_DATA_DIR}" >&2
  exit 1
fi

mkdir -p "${FLIGHTBOT_HOST_DATA_DIR}"

HOST_DATA_DIR_REALPATH="$(cd "${FLIGHTBOT_HOST_DATA_DIR}" && pwd -P)"
REPO_ROOT_REALPATH="$(cd "${REPO_ROOT}" && pwd -P)"

case "${HOST_DATA_DIR_REALPATH}" in
  "${REPO_ROOT_REALPATH}"|"${REPO_ROOT_REALPATH}"/*)
    echo "FLIGHTBOT_HOST_DATA_DIR must live outside the repo checkout: ${HOST_DATA_DIR_REALPATH}" >&2
    exit 1
    ;;
esac

export FLIGHTBOT_HOST_DATA_DIR="${HOST_DATA_DIR_REALPATH}"

mkdir -p "${FLIGHTBOT_HOST_DATA_DIR}"
touch "${FLIGHTBOT_HOST_DATA_DIR}/results.log"

if [[ ! -f "${FLIGHTBOT_HOST_DATA_DIR}/prices.json" ]]; then
  printf '{}\n' > "${FLIGHTBOT_HOST_DATA_DIR}/prices.json"
fi

if [[ ! -f "${FLIGHTBOT_HOST_DATA_DIR}/config.yml" ]]; then
  cat >&2 <<EOF
Missing ${FLIGHTBOT_HOST_DATA_DIR}/config.yml.
Initialize the host data directory before deploy:

  ${REPO_ROOT}/bootstrap/aws/init-datadir.sh ${FLIGHTBOT_HOST_DATA_DIR}

Then edit ${FLIGHTBOT_HOST_DATA_DIR}/config.yml with real runtime secrets and routes.
EOF
  exit 1
fi

cd "${REPO_ROOT}"
exec docker compose up -d --build
