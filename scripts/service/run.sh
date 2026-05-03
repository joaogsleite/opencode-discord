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

if [[ ! -x "./node_modules/.bin/tsx" ]]; then
  printf 'Missing ./node_modules/.bin/tsx. Run pnpm install first.\n' >&2
  exit 1
fi

exec ./node_modules/.bin/tsx src/index.ts
