# `/cmd` OpenCode Command Design

## Goal

Add a Discord slash command named `/cmd` for OpenCode custom commands. Users can list commands available to the configured OpenCode project and run a command against either the active session thread or a newly created session when invoked from a configured channel.

## Slash Command Shape

- `/cmd list` lists custom commands from the current configured OpenCode project.
- `/cmd run name:<command> prompt:<text>` runs a custom command. `name` uses autocomplete from the OpenCode command list. `prompt` is passed as the command arguments.

## Behavior

`/cmd list` ensures the OpenCode server is running for the channel project, calls `client.command.list()`, and displays command names with descriptions in a bounded Discord embed.

`/cmd run` has two modes:

- In an active session thread, it runs against the attached OpenCode session.
- In a configured parent channel, it creates a Discord thread and OpenCode session before running the command.

When creating a session from a parent channel, the session agent must match the selected OpenCode command's configured `agent`. If the command has no configured agent, fall back to the channel default agent and then `build`. The selected agent must pass the existing channel agent permission checks before the thread/session is created.

Command execution uses `client.session.command({ sessionID, command, arguments })` without passing agent or model overrides, so OpenCode preserves the command's own configuration during execution.

## Components

- `src/discord/commands/cmd.ts` owns command handling, OpenCode command normalization, reply formatting, thread creation, and session command execution.
- `src/discord/commands/index.ts` registers the `/cmd` slash command.
- `src/index.ts` wires the handler and autocomplete into the runtime command maps.
- Tests cover registration, list output, thread execution, parent-channel session creation, command-agent selection, and command-name autocomplete.

## Errors

The command follows existing structured error behavior:

- Missing channel config returns `CONFIG_CHANNEL_NOT_FOUND`.
- Running from a channel that cannot create threads returns `DISCORD_API_ERROR`.
- Running in a thread without an active session returns `SESSION_NOT_FOUND`.
- A missing command name returns a structured OpenCode command error using the existing Discord/API error code family.
- A command agent blocked by channel settings returns the existing agent permission error codes.

## Verification

Implementation must follow the project TDD workflow and finish with:

```bash
pnpm tsc --noEmit && pnpm test
```
