#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

START_BOT_SCRIPT="${SCRIPT_DIR}/start.sh"

LOGIN_SHELL="$(detect_login_shell)"
if [[ -z "${LOGIN_SHELL}" || ! -x "${LOGIN_SHELL}" ]]; then
  LOGIN_SHELL="/bin/sh"
fi

exec "${LOGIN_SHELL}" -lc 'exec /usr/bin/env bash "$START_BOT_SCRIPT"'
