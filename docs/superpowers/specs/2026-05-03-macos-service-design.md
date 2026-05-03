# macOS Background Service Design

## Goal

Run `opencode-discord` continuously on macOS, start it automatically when the current user logs in, and keep runtime logs inside this repository without committing them.

## Scope

- Support macOS only.
- Use a per-user LaunchAgent with label `com.opencode.discord`.
- Run the existing development entrypoint with `pnpm dev`.
- Manage the service through pnpm scripts backed by shell scripts.
- Store stdout and stderr logs under `logs/` in the repository.
- Keep generated logs out of git.

## Commands

Add pnpm scripts:

- `pnpm service:setup` installs or updates the LaunchAgent, loads it, and starts it.
- `pnpm service:stop` stops the running LaunchAgent-managed process without removing auto-start.
- `pnpm service:restart` restarts the LaunchAgent-managed process.
- `pnpm service:unsetup` stops the service, unloads the LaunchAgent, and removes the plist.
- `pnpm service:status` prints the LaunchAgent status for troubleshooting.

## Implementation

Use shell scripts in `scripts/service/`:

- `setup.sh` creates `logs/`, writes `~/Library/LaunchAgents/com.opencode.discord.plist`, bootstraps it into `gui/$UID`, and kickstarts it.
- `stop.sh` unloads the LaunchAgent without removing the plist and tolerates the service not already running.
- `restart.sh` unloads any running job, bootstraps the installed plist, and kickstarts the LaunchAgent.
- `unsetup.sh` stops, bootouts, and removes the plist.
- `status.sh` runs `launchctl print gui/$UID/com.opencode.discord`.

The plist uses:

- `WorkingDirectory` set to the repository root discovered by the scripts.
- `ProgramArguments` set to `pnpm dev` through `/usr/bin/env`.
- `RunAtLoad` enabled.
- `KeepAlive` enabled.
- `StandardOutPath` set to `logs/opencode-discord.out.log`.
- `StandardErrorPath` set to `logs/opencode-discord.err.log`.
- `EnvironmentVariables.PATH` copied from the current shell when setup runs.

## Error Handling

Scripts fail fast with clear shell errors for unsupported platforms or missing commands. Stop, restart, and unsetup tolerate an already-stopped or not-yet-installed service where that makes repeated usage safe.

## Git Ignore

Add `logs/` to `.gitignore`. Existing `*.log` already ignores log files, but the directory entry documents the runtime location and prevents accidental non-log files in `logs/` from being tracked.

## Verification

Run the project verification command after file changes:

```bash
pnpm tsc --noEmit && pnpm test
```

Manual service verification can be done with:

```bash
pnpm service:setup
pnpm service:status
pnpm service:restart
pnpm service:stop
pnpm service:unsetup
```
