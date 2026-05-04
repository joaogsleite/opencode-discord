#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

START_BOT_SCRIPT="${SCRIPT_DIR}/start.sh"

LOGIN_SHELL="$(detect_login_shell)"
if [[ -z "${LOGIN_SHELL}" || ! -x "${LOGIN_SHELL}" ]]; then
  LOGIN_SHELL="/bin/sh"
fi

exec "${LOGIN_SHELL}" -lc "
  cd ${REPO_ROOT}
  if command -v nvm >/dev/null 2>&1 ; then
    nvm use
  fi
  if ! command -v opencode >/dev/null 2>&1 ; then
    echo 'Missing opencode CLI'
    exit 1
  fi
  if ! -x "./node_modules/.bin/tsx" ; then
    echo 'Missing ./node_modules/.bin/tsx. Run pnpm install first.'
    exit 1
  fi
  exec ./node_modules/.bin/tsx src/index.ts
"
