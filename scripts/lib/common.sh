#!/usr/bin/env bash
#
# Shared helpers for flightbot scripts.
# Source this instead of repeating `source .env && ssh -i "$SSH_KEY_PATH" ...`.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
#
# Provides: REPO_ROOT, remote_ssh, remote_rsync, require_container, die, info

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
REMOTE_DIR="${FLIGHTBOT_REMOTE_DIR:-/home/ec2-user/flightbot}"
CONTAINER="${FLIGHTBOT_CONTAINER:-flightbot}"

die()  { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# Load .env without echoing secrets.
[[ -f "${ENV_FILE}" ]] || die "Missing ${ENV_FILE}. Copy .env.example to .env and fill it in."
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${SSH_KEY_PATH:?SSH_KEY_PATH is not set in .env}"
: "${SSH_USER:?SSH_USER is not set in .env}"
: "${SSH_HOST:?SSH_HOST is not set in .env}"

# Expand a leading ~ so ssh gets a real path.
SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
[[ -f "${SSH_KEY_PATH}" ]] || die "SSH key not found at ${SSH_KEY_PATH}"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20 -i "${SSH_KEY_PATH}")

# remote_ssh <command...>
remote_ssh() {
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "$@"
}

# remote_rsync <local-path> [remote-relative-path]
# Defaults to the remote flightbot dir root.
remote_rsync() {
  local src="$1"
  local dest="${2:-}"
  rsync -az \
    -e "ssh ${SSH_OPTS[*]}" \
    "${src}" "${SSH_TARGET}:${REMOTE_DIR}/${dest}"
}

# Fail early with a clear message if the container is not running.
require_container() {
  local status
  status="$(remote_ssh "docker ps --filter name=${CONTAINER} --format '{{.Status}}'" || true)"
  [[ -n "${status}" ]] || die "Container '${CONTAINER}' is not running on ${SSH_HOST}. Run scripts/deploy.sh first."
}
