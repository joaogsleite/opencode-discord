#!/usr/bin/env bash

set -euo pipefail

SERVICE_LABEL="com.opencode.discord"
PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
STDOUT_LOG="${LOG_DIR}/opencode-discord.out.log"
STDERR_LOG="${LOG_DIR}/opencode-discord.err.log"
RUN_SCRIPT="${SCRIPT_DIR}/run.sh"
LAUNCHCTL_DOMAIN="gui/$(id -u)"
LAUNCHCTL_TARGET="${LAUNCHCTL_DOMAIN}/${SERVICE_LABEL}"

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'This service is macOS-only.\n' >&2
    exit 1
  fi
}

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "${command_name}" >&2
    exit 1
  fi
}

is_bootstrapped() {
  launchctl print "${LAUNCHCTL_TARGET}" >/dev/null 2>&1
}

bootout_if_loaded() {
  if is_bootstrapped; then
    launchctl bootout "${LAUNCHCTL_DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  fi
}

stop_if_loaded() {
  if is_bootstrapped; then
    launchctl kill TERM "${LAUNCHCTL_TARGET}" >/dev/null 2>&1 || true
  fi
}
