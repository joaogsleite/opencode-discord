# macOS Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add macOS-only pnpm scripts that install, control, restart, and remove a per-user LaunchAgent running `pnpm dev` in the background with repo-local logs.

**Architecture:** Use small shell scripts under `scripts/service/` because the user chose shell scripts only. `setup.sh` generates the LaunchAgent plist from the current repo path and environment, while the other scripts wrap `launchctl` operations for stop, restart, status, and unsetup. Package scripts expose these operations through pnpm.

**Tech Stack:** macOS `launchctl`, LaunchAgent plist XML, POSIX shell via `bash`, Node package scripts via `pnpm`.

---

## File Structure

- Create `scripts/service/lib.sh`: shared constants and helper functions for macOS validation, repo root discovery, plist path, service target, and launchctl wrappers.
- Create `scripts/service/setup.sh`: creates logs, writes the LaunchAgent plist, unloads any existing copy, loads it, and starts it.
- Create `scripts/service/stop.sh`: unloads the running service without removing the LaunchAgent plist.
- Create `scripts/service/restart.sh`: unloads any running job, bootstraps the installed plist, and starts it.
- Create `scripts/service/unsetup.sh`: stops, unloads, and removes the LaunchAgent plist.
- Create `scripts/service/status.sh`: prints LaunchAgent status.
- Modify `package.json`: add `service:*` scripts.
- Modify `.gitignore`: add `logs/`.
- Modify `README.md`: document service commands and log paths.

### Task 1: Add Shared Shell Helpers

**Files:**
- Create: `scripts/service/lib.sh`

- [ ] **Step 1: Create the shared helper file**

Create `scripts/service/lib.sh` with this content:

```bash
#!/usr/bin/env bash

set -euo pipefail

SERVICE_LABEL="com.opencode.discord"
PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
STDOUT_LOG="${LOG_DIR}/opencode-discord.out.log"
STDERR_LOG="${LOG_DIR}/opencode-discord.err.log"
LAUNCHCTL_TARGET="gui/$(id -u)/${SERVICE_LABEL}"

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
    launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" >/dev/null 2>&1 || true
  fi
}

stop_if_loaded() {
  if is_bootstrapped; then
    launchctl kill TERM "${LAUNCHCTL_TARGET}" >/dev/null 2>&1 || true
  fi
}
```

- [ ] **Step 2: Make the helper executable**

Run:

```bash
chmod +x scripts/service/lib.sh
```

Expected: command exits with status 0.

### Task 2: Add Setup Script

**Files:**
- Create: `scripts/service/setup.sh`

- [ ] **Step 1: Create setup script**

Create `scripts/service/setup.sh` with this content:

```bash
#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl
require_command pnpm

mkdir -p "${LOG_DIR}"
mkdir -p "$(dirname "${PLIST_PATH}")"

cat >"${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>pnpm</string>
    <string>dev</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>
</dict>
</plist>
PLIST

bootout_if_loaded
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
launchctl kickstart -k "${LAUNCHCTL_TARGET}"

printf 'Installed and started %s\n' "${SERVICE_LABEL}"
printf 'stdout: %s\n' "${STDOUT_LOG}"
printf 'stderr: %s\n' "${STDERR_LOG}"
```

- [ ] **Step 2: Make setup executable**

Run:

```bash
chmod +x scripts/service/setup.sh
```

Expected: command exits with status 0.

### Task 3: Add Control Scripts

**Files:**
- Create: `scripts/service/stop.sh`
- Create: `scripts/service/restart.sh`
- Create: `scripts/service/unsetup.sh`
- Create: `scripts/service/status.sh`

- [ ] **Step 1: Create stop script**

Create `scripts/service/stop.sh` with this content:

```bash
#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

if is_bootstrapped; then
  launchctl kill TERM "${LAUNCHCTL_TARGET}" >/dev/null 2>&1 || true
  printf 'Stopped %s\n' "${SERVICE_LABEL}"
else
  printf '%s is not loaded.\n' "${SERVICE_LABEL}"
fi
```

- [ ] **Step 2: Create restart script**

Create `scripts/service/restart.sh` with this content:

```bash
#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

if ! is_bootstrapped; then
  printf '%s is not loaded. Run pnpm service:setup first.\n' "${SERVICE_LABEL}" >&2
  exit 1
fi

stop_if_loaded
launchctl kickstart -k "${LAUNCHCTL_TARGET}"
printf 'Restarted %s\n' "${SERVICE_LABEL}"
```

- [ ] **Step 3: Create unsetup script**

Create `scripts/service/unsetup.sh` with this content:

```bash
#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

stop_if_loaded
bootout_if_loaded

if [[ -f "${PLIST_PATH}" ]]; then
  rm "${PLIST_PATH}"
  printf 'Removed %s\n' "${PLIST_PATH}"
else
  printf '%s was already removed.\n' "${PLIST_PATH}"
fi

printf 'Uninstalled %s\n' "${SERVICE_LABEL}"
```

- [ ] **Step 4: Create status script**

Create `scripts/service/status.sh` with this content:

```bash
#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

launchctl print "${LAUNCHCTL_TARGET}"
```

- [ ] **Step 5: Make control scripts executable**

Run:

```bash
chmod +x scripts/service/stop.sh scripts/service/restart.sh scripts/service/unsetup.sh scripts/service/status.sh
```

Expected: command exits with status 0.

### Task 4: Add Package Scripts and Ignore Logs

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update package scripts**

Modify `package.json` scripts to include service commands:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "service:setup": "bash scripts/service/setup.sh",
    "service:stop": "bash scripts/service/stop.sh",
    "service:restart": "bash scripts/service/restart.sh",
    "service:unsetup": "bash scripts/service/unsetup.sh",
    "service:status": "bash scripts/service/status.sh"
  }
}
```

- [ ] **Step 2: Ignore logs directory**

Append this line to `.gitignore`:

```gitignore
logs/
```

### Task 5: Document Service Usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add runtime log row**

In the `Runtime Files` table, add:

```markdown
| `logs/` | LaunchAgent stdout and stderr logs. Ignored by git. |
```

- [ ] **Step 2: Add service commands to development script table**

In the `Useful scripts` table, add:

```markdown
| `pnpm service:setup` | Install/update the macOS LaunchAgent and start the bot at user login. |
| `pnpm service:status` | Print LaunchAgent status for `com.opencode.discord`. |
| `pnpm service:stop` | Stop the running LaunchAgent-managed process without removing auto-start. |
| `pnpm service:restart` | Restart the LaunchAgent-managed process. |
| `pnpm service:unsetup` | Stop, unload, and remove the macOS LaunchAgent. |
```

- [ ] **Step 3: Add operational note**

In `Operational Notes`, add:

```markdown
macOS background service management is available through `pnpm service:*` scripts. The service starts when the current macOS user logs in, runs `pnpm dev` from this repository, and writes logs to `logs/opencode-discord.out.log` and `logs/opencode-discord.err.log`.
```

### Task 6: Verify

**Files:**
- No code files expected beyond prior tasks.

- [ ] **Step 1: Run project verification**

Run:

```bash
pnpm tsc --noEmit && pnpm test
```

Expected: TypeScript and Vitest both pass.

- [ ] **Step 2: Check service scripts parse**

Run:

```bash
bash -n scripts/service/lib.sh scripts/service/setup.sh scripts/service/stop.sh scripts/service/restart.sh scripts/service/unsetup.sh scripts/service/status.sh
```

Expected: command exits with status 0.

- [ ] **Step 3: Optional manual macOS service verification**

Run only if the current user wants the service installed immediately:

```bash
pnpm service:setup
pnpm service:status
pnpm service:restart
pnpm service:stop
```

Expected: setup installs the LaunchAgent, status prints LaunchAgent metadata, restart succeeds, and stop stops the process while leaving auto-start installed.

---

## Self-Review

- Spec coverage: The plan covers shell scripts, `pnpm service:*` commands, LaunchAgent label `com.opencode.discord`, `pnpm dev`, user-login auto-start, repo-local logs, gitignored logs, and verification.
- Placeholder scan: No placeholders remain.
- Type consistency: Not applicable for TypeScript APIs; shell variable and script names are consistent across tasks.
