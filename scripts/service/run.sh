#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos

NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
NVM_SCRIPT="${NVM_DIR}/nvm.sh"

if [[ ! -s "${NVM_SCRIPT}" ]]; then
  printf 'Missing nvm script: %s\n' "${NVM_SCRIPT}" >&2
  exit 1
fi

cd "${REPO_ROOT}"
source "${NVM_SCRIPT}"
nvm use
export PATH="${HOME}/.opencode/bin:${PATH}"

if ! command -v opencode >/dev/null 2>&1; then
  printf 'Missing opencode CLI. Install it or ensure %s/.opencode/bin is available.\n' "${HOME}" >&2
  exit 1
fi

if [[ ! -x "./node_modules/.bin/tsx" ]]; then
  printf 'Missing ./node_modules/.bin/tsx. Run pnpm install first.\n' >&2
  exit 1
fi

exec ./node_modules/.bin/tsx src/index.ts
