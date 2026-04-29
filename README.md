# opencode-discord

Discord bot that maps Discord channels to local OpenCode projects. Users start or connect to OpenCode sessions with slash commands, then continue the conversation in Discord threads.

This repository is a Node.js and TypeScript project using `discord.js` v14 and `@opencode-ai/sdk/v2`.

## What It Does

Each configured Discord channel points at one local project path. The bot starts one `opencode serve` process per unique project path, creates Discord threads for sessions, streams OpenCode output back to Discord, and persists runtime state so sessions can recover after restarts.

Typical flow:

1. Configure a Discord server and one or more channel mappings in `config.yaml`.
2. Run the bot locally on the machine that has access to the configured project paths.
3. Use `/new` in a mapped Discord channel to create an OpenCode session thread.
4. Send normal messages in the thread to talk to the OpenCode agent.
5. Use slash commands in the thread for session controls such as model selection, queue management, diffs, reverts, summaries, and file context.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | Built for modern Node.js. |
| pnpm | The repo declares `pnpm@10.33.1`. |
| OpenCode CLI | `opencode` must be available in `PATH`. Startup checks `opencode --version`. |
| Discord bot token | Create an application and bot in the Discord Developer Portal. |
| Discord message content intent | Required for thread passthrough messages. |
| Local project paths | The bot must run on the same machine where configured projects exist. |

## Setup

Install dependencies:

```bash
pnpm install
```

Copy the example config:

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` with your Discord token, guild IDs, channel IDs, and local project paths.

Run in development:

```bash
pnpm dev
```

Run checks:

```bash
pnpm typecheck
pnpm test
```

## Configuration

Runtime configuration lives in `config.yaml` at the repo root. This file is ignored by git because it contains secrets.

Use `config.example.yaml` as the reference. Minimal shape:

```yaml
discordToken: "YOUR_BOT_TOKEN_HERE"
servers:
  - serverId: "111111111111111111"
    channels:
      - channelId: "123456789012345678"
        projectPath: "/absolute/path/to/project"
```

Channel options:

| Field | Default | Purpose |
| --- | --- | --- |
| `channelId` | Required | Discord text channel ID. |
| `projectPath` | Required | Absolute local project path served by OpenCode. |
| `defaultAgent` | `build` in callers when omitted | Agent used when a command does not specify one. |
| `allowAgentSwitch` | `true` | Allows `/agent set` and `/new agent:<name>`. |
| `allowedAgents` | `[]` | Agent allowlist. Empty means all agents. |
| `allowedUsers` | `[]` | Discord user allowlist. Empty means all channel members. |
| `permissions` | `auto` | `auto` grants agent permissions automatically. `interactive` asks with buttons. |
| `questionTimeout` | `300` | Seconds to wait for user answers to agent questions. |
| `connectHistoryLimit` | `10` | Number of prior messages replayed by `/connect`. Use `0` to disable replay. |
| `autoConnect` | `false` | Auto-create Discord threads for externally created OpenCode sessions. |

Notes:

| Topic | Behavior |
| --- | --- |
| Multiple channels per project | Allowed. They share one `opencode serve` process for the same `projectPath`. |
| Multiple `autoConnect` channels | Avoid this for the same `projectPath`. The implementation uses the first matching channel. |
| Model config | Not configured in `config.yaml`. Configure models in each project OpenCode config. |
| Hot reload | Config changes are watched and valid reloads update in-memory config. Invalid reloads are rejected and the previous config remains active. |

## Discord Usage

Use channel-level commands in configured parent channels. Use thread-level commands inside session threads.

Channel-level flow:

1. Run `/new prompt:<text>` to create a new OpenCode session and Discord thread.
2. Optionally pass `agent:<name>` and `title:<thread title>`.
3. Use `/connect session:<id>` to attach a new thread to an existing OpenCode session.
4. Use `/status`, `/agent list`, `/model list`, `/ls`, `/cat`, `/download`, `/git`, `/mcp`, and `/help` from a mapped channel.

Thread-level flow:

1. Send normal messages in the thread to prompt the agent.
2. Send more messages while the agent is busy to queue them.
3. Use `/interrupt` to abort the current session work and clear the queue.
4. Use `/context add` before the next message to include files from the project.
5. Use `/diff`, `/revert`, `/unrevert`, `/summary`, `/fork`, `/todo`, and `/retry` for session workflow controls.
6. Use `/end` to end the Discord thread mapping and archive the thread.

## Command Overview

| Command | Context | Purpose |
| --- | --- | --- |
| `/new` | Channel | Create a new OpenCode session thread. |
| `/connect` | Channel | Attach a Discord thread to an existing OpenCode session. |
| `/agent set` | Thread | Change the active session agent. |
| `/agent list` | Channel or thread | List available agents. |
| `/model set` | Thread | Change the active session model. |
| `/model list` | Channel or thread | List available models. |
| `/interrupt` | Thread | Abort the active OpenCode session task and clear queued messages. |
| `/queue list` | Thread | Show queued messages. |
| `/queue clear` | Thread | Clear queued messages. |
| `/info` | Thread | Show session metadata, queue length, MCP status, usage, and cost. |
| `/end` | Thread | End the Discord mapping and archive the thread. |
| `/status` | Channel | Show project server and active session status. |
| `/help` | Channel or thread | Show context-aware command help. |
| `/git status` | Channel or thread | Show local git status for the project. |
| `/git log` | Channel or thread | Show recent commits. |
| `/git diff` | Channel or thread | Show local git diff. |
| `/git branch` | Channel or thread | Show current branch. |
| `/git branches` | Channel or thread | List local branches. |
| `/git checkout` | Channel or thread | Checkout or create a local branch. |
| `/git stash save` | Channel or thread | Save a git stash. |
| `/git stash pop` | Channel or thread | Pop the latest git stash. |
| `/git stash list` | Channel or thread | List git stashes. |
| `/git reset` | Channel or thread | Unstage files or run confirmed hard reset. |
| `/ls` | Channel or thread | List project files or directories. |
| `/cat` | Channel or thread | Show project file contents. |
| `/download` | Channel or thread | Download a project file. |
| `/restart` | Channel or thread | Restart the OpenCode server for the project after confirmation. |
| `/mcp list` | Channel or thread | Show MCP server connection status. |
| `/mcp reconnect` | Channel or thread | Reconnect one or all MCP servers. |
| `/mcp disconnect` | Channel or thread | Disconnect an MCP server. |
| `/diff` | Thread | Show OpenCode session diff. |
| `/revert` | Thread | Revert the selected or latest assistant message. |
| `/unrevert` | Thread | Undo the last revert. |
| `/summary` | Thread | Summarize and compact the session. |
| `/fork` | Thread | Fork the current session into a new thread. |
| `/todo` | Thread | Show the agent todo list. |
| `/retry` | Thread | Revert and resend the last user prompt. |
| `/context add` | Thread | Add up to five project files to the next prompt. |
| `/context list` | Thread | List pending context files. |
| `/context clear` | Thread | Clear pending context files. |

## Runtime Files

| Path | Purpose |
| --- | --- |
| `config.yaml` | Local bot configuration and Discord token. Ignored by git. |
| `state.json` | Persisted server, session, and queue state. Ignored by git. |
| `.cache/` | Cached agents, models, sessions, and MCP status. Ignored by git. |
| `<project>/.opencode/attachments/` | Downloaded Discord attachments for prompt file parts. |

## Development

Useful scripts:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run `src/index.ts` through `tsx`. |
| `pnpm test` | Run Vitest once. |
| `pnpm test:watch` | Run Vitest in watch mode. |
| `pnpm typecheck` | Run TypeScript without emitting files. |

Project conventions are documented in `AGENTS.md`. The short version is strict TypeScript, named exports, Zod config validation, `BotError` for structured errors, atomic state writes, and TDD for code changes.

## Operational Notes

The bot manages `opencode serve` processes itself. It starts servers on demand, shares one server per project path, watches health, and persists process metadata in `state.json`.

For production-like use:

1. Keep `config.yaml`, `state.json`, `.cache/`, and logs out of git.
2. Run the bot on a machine with stable access to every configured project path.
3. Enable the Discord bot intents needed for guild messages and message content.
4. Treat `permissions: auto` as full trust for the configured project.
