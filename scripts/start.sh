#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "${REPO_ROOT}"

if command -v nvm >/dev/null 2>&1; then
  nvm use
fi

if ! command -v opencode >/dev/null 2>&1; then
  printf 'Missing opencode CLI. Install it or ensure %s/.opencode/bin is available.\n' "${HOME}" >&2
  exit 1
fi

if [[ ! -x "./node_modules/.bin/tsx" ]]; then
  printf 'Missing ./node_modules/.bin/tsx. Run pnpm install first.\n' >&2
  exit 1
fi

exec ./node_modules/.bin/tsx src/index.ts
