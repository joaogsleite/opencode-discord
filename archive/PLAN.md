# opencode-discord -- Implementation Plan

## Overview

A Discord bot (single bot token, multi-server) that maps Discord channels to OpenCode agents on specific local projects. Users create sessions via `/new` (or attach to existing sessions via `/connect`), then interact with the agent naturally in threads via always-on passthrough. The bot manages its own `opencode serve` instances -- one per unique project path -- using the official `@opencode-ai/sdk`.

---

## Config

### Format & Location

- **Format**: YAML, validated against a Zod schema on startup.
- **Location**: Project root -- `config.yaml` (gitignored) and `config.example.yaml` (committed).
- **Hot-reload**: Watched via `chokidar`; changes applied without restart.

See [`config.example.yaml`](config.example.yaml) for the full schema with inline comments documenting every field (required/optional, defaults, behavior).

### Startup Validation

On startup the bot parses and validates `config.yaml` against the Zod schema, then deploys/syncs slash commands to each listed server.

### Hot-Reload Behavior

- On change: re-parse, re-validate, update in-memory config.
- **Channels removed from config**: active sessions in those channels are ended immediately -- threads are archived, sessions are cleaned up, state is updated.
- New sessions use the updated config.
- Slash commands are re-deployed if the server list changes.

---

## State Persistence

### Overview

The bot persists runtime state to a JSON file (`state.json` next to `config.yaml`) so that sessions, server references, and message queues survive bot restarts. No external database dependency required.

### State File

- **Location**: `state.json` in the project root (gitignored)
- **Read**: On bot startup, loaded into an in-memory object.
- **Write**: On every state mutation, the in-memory object is written to disk via atomic write (write to `state.json.tmp`, then `fs.renameSync`).
- **All reads at runtime come from the in-memory object** -- no disk I/O on the hot path.

### Schema

```json
{
  "version": 1,
  "servers": {
    "/Users/you/Developer/my-app": {
      "port": 10042,
      "pid": 48291,
      "url": "http://127.0.0.1:10042",
      "startedAt": 1714060800000,
      "status": "running"
    }
  },
  "sessions": {
    "1234567890123456": {
      "sessionId": "sess_abc123",
      "guildId": "111111111111111111",
      "channelId": "123456789012345678",
      "projectPath": "/Users/you/Developer/my-app",
      "agent": "build",
      "model": null,
      "createdBy": "222222222222222222",
      "createdAt": 1714060800000,
      "lastActivityAt": 1714060800000,
      "status": "active"
    }
  },
  "queues": {
    "1234567890123456": [
      {
        "userId": "222222222222222222",
        "content": "now fix the tests",
        "attachments": [],
        "queuedAt": 1714060900000
      }
    ]
  }
}
```

### What Gets Persisted vs. Runtime-Only

| Data | Persisted (JSON) | Runtime-Only (Memory) |
|------|------------------|-----------------------|
| Thread -> session mapping | Yes | Loaded into memory on startup |
| Server process info (port, PID, URL) | Yes | Process handle, SDK client instance are runtime-only |
| Message queue | Yes | Also in memory for fast access |
| Agent/model cache | Disk (`.cache/` files) | In-memory Map |
| SSE stream subscription | N/A | Runtime only (reconnected on restart) |
| Current streaming state | No | Runtime only (partial messages not recoverable) |
| Discord typing indicators | N/A | Runtime only |
| Context buffer (files) | No | Runtime only, cleared on send/restart |
| Pending question state | No | Runtime only (agent times out if bot restarts mid-question) |
| Active tool status | No | Runtime only (part of streaming state) |

### Bot Startup Recovery Flow

1. **Preflight check**: Verify `opencode` binary is available in PATH (`which opencode` or attempt `opencode --version`). If missing, log a fatal error with installation instructions and exit.
2. Load `state.json` (or create empty state if missing).
3. Load `config.yaml`, validate schema.
4. **Recover servers**: For each server in state where `status = 'running'`, check if PID is alive (`process.kill(pid, 0)`). If alive, health-check it -- healthy servers are reconnected via `createOpencodeClient({ baseUrl })` and their agent/model cache is refreshed; unhealthy ones are killed and marked `stopped`. Dead PIDs are marked `stopped`. Stopped servers restart lazily on next interaction (unless the project has `autoConnect` -- see step 7).
5. **Recover sessions**: For each `active`/`inactive` session, if its server is running, rebuild the in-memory mapping, re-subscribe to SSE, and post "Bot restarted. Session reconnected." in the thread. If the server is stopped, keep the mapping (it restarts on next interaction). If the thread was deleted, mark session `ended`.
6. **Recover queues**: Keep queued messages for recovered sessions; discard entries for ended sessions.
7. **Eager start for auto-connect projects**: For each project that has a channel with `autoConnect: true`, if its server is not already running (from step 4), start it now. Subscribe to SSE for `session.created` events. Diff `session.list()` against known sessions in state.json to detect sessions created while the bot was offline -- auto-connect any unattached sessions.
8. Connect Discord, sync commands, begin normal operation.

### Session States

OpenCode sessions are persistent -- they survive server restarts and are never automatically deleted. Sessions are only removed by explicit user action (e.g. deletion via TUI or API).

- **active**: Thread is live, server is running, messages go to agent. Entered via `/new` or `/connect`. Transitions to `inactive` after 24h without activity, or to `ended` via `/end` or channel removal from config.
- **inactive**: 24h no activity. Thread archived. Session mapping retained in state.json. Server may shut down via idle timer. Session still exists on the OpenCode server. Transitions back to `active` when a user unarchives the thread and sends a message.
- **ended**: `/end` called, or channel removed from config. Thread archived. Session cleaned up in state.json.

### Inactivity Check

- A periodic timer runs every 30 minutes.
- For each session where `status === 'active'` and `now - lastActivityAt > 24h`:
  - Mark status as `inactive` in state.json.
  - Archive the Discord thread.
  - Decrement the project's active session count (may trigger server idle shutdown).
- The session mapping stays in state.json so the bot knows to attempt reconnection if the thread is unarchived.

### Reconnection on Unarchive

When the message handler receives a message for a thread with an `inactive` session:
1. Start the opencode server for the project (if not already running).
2. Mark session as `active` in state.json.
3. Re-subscribe to SSE events.
4. Forward the message to the agent.

If the session is unexpectedly missing from the server (should not happen under normal circumstances), reply with an error in the thread and mark the session as `ended`.

---

## Interaction Model

### Channel Level (Commands Only)

Regular messages in mapped channels are **ignored** by the bot. Only slash commands work at channel level.

**Commands:** `/new`, `/connect`, `/agent list`, `/model list`, `/status`, `/help`, `/ls`, `/cat`, `/download`, `/git *`, `/restart`, `/mcp list/reconnect/disconnect`

### Thread Level (Passthrough + Commands)

Inside a session thread:
- **All non-bot messages** are forwarded to the OpenCode agent as prompts (always-on passthrough). Threads mapped to an OpenCode session are exclusively for agent interaction -- no side conversations.
- **Slash commands** provide control over the session.

**Commands:** `/agent set/list`, `/model set/list`, `/interrupt`, `/queue list/clear`, `/info`, `/end`, `/help`, `/ls`, `/cat`, `/download`, `/git *`, `/restart`, `/mcp list/reconnect/disconnect`, `/diff`, `/revert`, `/unrevert`, `/summary`, `/fork`, `/todo`, `/retry`, `/context add/list/clear`

---

## Slash Command Details

### `/new`

- **Where**: Channel only
- **Args**:
  - `prompt` (required, string): The first message to send to the agent.
  - `agent` (optional, string, **autocomplete**): Override the channel's `defaultAgent`. Validated against `allowedAgents`/`allowAgentSwitch`.
  - `title` (optional, string): Thread name. Defaults to first ~50 characters of `prompt`.
- **Behavior**: Validate permissions and agent selection, ensure server is running, create a Discord thread and OpenCode session, persist to state.json, send the prompt, and stream the response into the thread.

### `/connect`

- **Where**: Channel only
- **Args**:
  - `session` (required, string, **autocomplete**): Session to attach to. Autocomplete shows unattached session titles; submits session ID.
  - `title` (optional, string): Thread name. Defaults to session's existing title.
- **Behavior**: Validate permissions, ensure server is running, verify session exists and isn't already attached to another thread, create a Discord thread, persist mapping to state.json, subscribe to SSE, replay session history into the thread, and post confirmation.
- **Session History Replay & Gap Recovery**:
  - Fetch recent messages via `session.messages({ limit: connectHistoryLimit })`. The `connectHistoryLimit` is a per-channel config option (default 10, set to 0 to disable replay).
  - Post messages chronologically (oldest first) with ~250ms delay between messages. Formatting:
    - **User messages**: `**User:**` + blockquoted text
    - **Assistant messages**: `**Assistant:**` + normal formatted text (same `formatter.ts` logic as live streaming)
    - **Tool usage**: Compact summary lines before text content (`> Used **bash**: \`npm test\``)
  - For each message: extract `TextPart`s (concatenate text), `ToolPart`s (completed tools only -- tool name + first ~100 chars of input), and `FilePart`s (attach to Discord message).
  - Record the ID of the last replayed message as `lastReplayedMessageId`.
  - Post confirmation: "Connected to session `<sessionId>`."
  - **Gap recovery**: Fetch `session.messages()` again. Post any messages newer than `lastReplayedMessageId` not already handled by SSE (deduplicate by message ID via a per-thread Set shared with the stream handler). This catches responses that completed between thread creation and SSE subscription.
  - **Edge cases**: Empty session → skip replay; fetch fails → log error, skip replay (non-fatal); messages from non-Discord clients → label shows "User" without username; active session → gap recovery catches in-flight responses.

### `/agent set`

- **Where**: Thread only
- **Args**:
  - `agent` (required, string, **autocomplete**): The agent to switch to.
- **Behavior**:
  - If `allowAgentSwitch` is `false` for the channel: reject with error message.
  - If `allowedAgents` is non-empty and the agent is not in the list: reject.
  - Otherwise: update the thread-local agent. Persist to state.json. Next message uses the new agent.

### `/agent list`

- **Where**: Channel or Thread
- **Behavior**: Query the OpenCode server for available agents (`client.app.agents()`). Starts the server if needed. Filter by `allowedAgents` if configured. Display as a formatted embed with agent names and descriptions.

### `/model set`

- **Where**: Thread only
- **Args**:
  - `model` (required, string, **autocomplete**): Model ID (e.g. `anthropic/claude-sonnet-4-20250514`).
- **Behavior**: Update the thread-local model. Persist to state.json. Next prompt uses the new model.

### `/model list`

- **Where**: Channel or Thread
- **Behavior**: Query the OpenCode server for available providers/models. Starts the server if needed. Display as a formatted embed grouped by provider.

### `/interrupt`

- **Where**: Thread only
- **Behavior**: Call `client.session.abort({ path: { id: sessionId } })` to stop the current task. Also clear the message queue for this thread to prevent queued messages from firing after interruption. Confirm in the thread.

### `/queue list`

- **Where**: Thread only
- **Behavior**: Display the pending message queue for this thread (position, content preview). Show "Queue empty" if no messages pending.

### `/queue clear`

- **Where**: Thread only
- **Behavior**: Clear all queued messages. Persist to state.json. Confirm in the thread.

### `/info`

- **Where**: Thread only
- **Behavior**: Display an embed with: session ID, agent, model, project path, status (idle/busy), queue length, uptime, MCP status, token usage, and cost.
  - **MCP status**: Call `client.mcp.status()`. List each MCP server name with its status (`connected`, `disabled`, `failed` + error message, `needs_auth`).
  - **Token usage**: Total input, output, reasoning, and cache (read/write) tokens for the session. Fetched on demand by calling `session.messages()` and summing `tokens` from all `AssistantMessage`s.
  - **Cost**: Cumulative dollar cost for the session. Summed from `cost` field on all `AssistantMessage`s.

### `/end`

- **Where**: Thread only
- **Behavior**: Abort any in-progress task, clean up the session and its attachment files, decrement active session count (may trigger idle shutdown), archive the thread, and update state.json.

### `/status`

- **Where**: Channel only
- **Behavior**: Display an embed showing:
  - Server status for this channel's project (running/stopped, uptime, port)
  - Number of active sessions
  - List of active threads with their agent, user, and queue depth

### `/help`

- **Where**: Channel or Thread
- **Behavior**: Show available commands for the current context (channel vs. thread) as an ephemeral reply.

### `/git` (Command Group)

All git subcommands execute directly on the project's local filesystem via `child_process.execFile` -- no OpenCode server required. Available in both channel and thread contexts.

#### `/git status`

- **Args**: *(none)*
- **Behavior**: Run `git status --short` in the project directory. Format output as an embed with a code block.

#### `/git log`

- **Args**:
  - `count` (optional, integer, default 10): Number of commits to show.
- **Behavior**: Run `git log --oneline` with short hash, relative date, author, and message. Format as an embed with a code block. Truncate at ~1800 chars.

#### `/git diff`

- **Args** (all optional):
  - `target`: `unstaged` (default), `staged`, or `branch`
  - `base`: Base branch for branch diff (default: `main`)
  - `stat`: Boolean, show `--stat` summary only
- **Behavior**: Run git diff in the project directory, format output in a `diff` code block, truncate if over Discord's 2000-char limit.

#### `/git branch`

- **Args**: *(none)*
- **Behavior**: Show the current branch name. Just outputs the result of `git branch --show-current`.

#### `/git branches`

- **Args**: *(none)*
- **Behavior**: List all local branches via `git branch`. Mark the current branch with `*`. Format as a code block.

#### `/git checkout`

- **Args**:
  - `branch` (required, string, **autocomplete**): Branch name.
  - `create` (optional, boolean, default `false`): If `true`, run `git checkout -b`.
- **Behavior**: Refuse if there are uncommitted changes. Otherwise run `git checkout [-b] <branch>` and confirm.

#### `/git stash save`

- **Args**:
  - `message` (optional, string): Stash message.
- **Behavior**: Run `git stash push -m "<message>"` (or `git stash push` if no message). Confirm in the thread.

#### `/git stash pop`

- **Args**: *(none)*
- **Behavior**: Run `git stash pop`. Confirm in the thread. Report errors (e.g. conflicts) to the user.

#### `/git stash list`

- **Args**: *(none)*
- **Behavior**: Run `git stash list`. Format as a code block. If empty, report "No stashes."

#### `/git reset`

- **Args**:
  - `target` (required, string choices: `staged`, `hard`):
    - `staged`: Unstage all staged files (`git reset HEAD`). No confirmation needed.
    - `hard`: Discard all uncommitted changes (`git reset --hard HEAD`). **Destructive** -- sends a Discord message with a confirmation button. Only executes on button click. Button expires after 30 seconds.
- **Behavior**: Execute the appropriate git reset command. For `hard`, use an interactive button confirmation before executing.

### `/ls`

- **Where**: Channel or Thread
- **Args**:
  - `path` (optional, string, **autocomplete**): Directory path relative to project root. Defaults to root. Autocomplete lists directories only.
- **Behavior**: Resolve path safely (reject escapes), list children via `fs.readdir`, format with trailing `/` for directories, send as code block.

### `/cat`

- **Where**: Channel or Thread
- **Args**:
  - `file` (required, string, **autocomplete**): File path relative to project root.
  - `start` (optional, integer): Start line (1-indexed).
  - `end` (optional, integer): End line.
- **Behavior**: Resolve path safely, read file (optionally sliced by line range), infer language from extension for syntax highlighting, display in fenced code block. Truncate at ~1800 chars with a note.

### `/download`

- **Where**: Channel or Thread
- **Args**:
  - `file` (required, string, **autocomplete**): File path relative to project root.
- **Behavior**: Resolve path safely, send file as a Discord attachment via `AttachmentBuilder`. Report errors on failure.

### `/restart`

- **Where**: Channel or Thread
- **Args**: None
- **Behavior**:
  1. Send an embed with a confirmation button: "This will restart the OpenCode server for **\<projectPath\>**. All active sessions ({count}) will be interrupted." Button text: "Restart". Expires after 30 seconds.
  2. On button click: abort all active sessions on the project, kill the server process.
  3. Respawn via `createOpencode()`, wait for health check.
  4. Notify all active threads on the project: "Server restarted. Session reconnected."
  5. Re-subscribe all threads to SSE, refresh agent/model/MCP cache.

### `/mcp` (Command Group)

All MCP subcommands require the OpenCode server to be running (starts it if needed).

#### `/mcp list`

- **Where**: Channel or Thread
- **Behavior**: Call `client.mcp.status()`. Display an embed listing each MCP server name with its status. Status indicators: `connected`, `disabled`, `failed` (+ error message), `needs_auth`.

#### `/mcp reconnect`

- **Where**: Channel or Thread
- **Args**:
  - `name` (optional, string, **autocomplete**): MCP server name. Autocomplete from `client.mcp.status()` keys. If omitted, reconnect all MCPs.
- **Behavior**: Call `client.mcp.connect({ path: { name } })` for the specified MCP, or iterate all MCP servers and reconnect each. Report results per MCP.

#### `/mcp disconnect`

- **Where**: Channel or Thread
- **Args**:
  - `name` (required, string, **autocomplete**): MCP server name. Autocomplete from `client.mcp.status()` keys.
- **Behavior**: Call `client.mcp.disconnect({ path: { name } })`. Confirm in the channel/thread.

### `/diff`

- **Where**: Thread only
- **Args**: None
- **Behavior**: Call `client.session.diff({ path: { id: sessionId } })` to get file changes made by the agent in this session. Format as a `diff` code block. Split across multiple messages if long (same splitting logic as regular responses). If no changes, show "No file changes in this session." This is distinct from `/git diff` -- it shows only what the agent changed in this session, not all uncommitted work.

### `/revert`

- **Where**: Thread only
- **Args**:
  - `message` (optional, string, **autocomplete**): The assistant message to revert. Autocomplete shows the last 15 assistant messages with a truncated preview (~50 chars of what the agent did). Submits `messageID`. If omitted, reverts the last assistant message.
- **Behavior**: Call `client.session.revert({ path: { id: sessionId }, body: { messageID } })`. Confirm what was reverted in the thread. If there is no assistant message to revert, respond with an error.

### `/unrevert`

- **Where**: Thread only
- **Args**: None
- **Behavior**: Call `client.session.unrevert({ path: { id: sessionId } })`. Restores the last reverted message. Confirm in the thread.

### `/summary`

- **Where**: Thread only
- **Args**:
  - `model` (optional, string, **autocomplete**): Model to use for summarization (e.g. `anthropic/claude-sonnet-4-20250514`). Autocomplete from cached models. Defaults to the session's current model/provider.
- **Behavior**: Parse the `model` arg into `providerID` and `modelID`. Call `client.session.summarize({ path: { id: sessionId }, body: { providerID, modelID } })`. Post the summary in the thread. This also compacts the session's context window, which helps with long sessions approaching the context limit.

### `/fork`

- **Where**: Thread only
- **Args**:
  - `message` (optional, string, **autocomplete**): The point to fork from. Autocomplete shows recent messages (both user and assistant) with a truncated preview. Submits `messageID`. If omitted, forks from the latest message.
  - `title` (optional, string): Thread name for the fork. Defaults to "Fork of \<original thread name\>".
- **Behavior**:
  1. Call `client.session.fork({ path: { id: sessionId }, body: { messageID } })`. Returns the new session.
  2. Create a new Discord thread in the same channel.
  3. Persist the new session mapping in state.json.
  4. Subscribe to SSE for the new session.
  5. Post in the original thread: "Session forked -> \[link to new thread\]"
  6. Post in the new thread: "Forked from \[link to original thread\] at message \<preview\>"

### `/todo`

- **Where**: Thread only
- **Args**: None
- **Behavior**: Call `client.session.todo({ path: { id: sessionId } })`. Display the agent's current task list as an embed with status indicators (pending, in-progress, completed).

### `/retry`

- **Where**: Thread only
- **Args**: None
- **Behavior**:
  1. Get the last user message and last assistant message from `session.messages()`.
  2. Call `client.session.revert({ path: { id: sessionId }, body: { messageID: lastAssistantMessageID } })` to undo the last agent response.
  3. Resend the same user prompt via `session.promptAsync()`.
  4. Stream the new response into the thread.
  5. If there is no previous user message, respond with an error.

### `/context` (Command Group)

Manages a per-thread file context buffer. Buffered files are automatically included as `FilePartInput` parts alongside the user's text when the next message is sent in the thread. The buffer is cleared after it is consumed.

#### `/context add`

- **Where**: Thread only
- **Args**:
  - `file1` (required, string, **autocomplete**): File path relative to project root.
  - `file2` through `file5` (optional, string, **autocomplete**): Additional file paths.
  - Autocomplete works like `/cat` -- shows files and directories from the local filesystem.
- **Behavior**: Add the specified files to the thread's context buffer. Responds ephemerally: "Added {count} file(s) to context: `file1`, `file2`, ... These will be included with your next message." Can be called multiple times -- new files are appended to the existing buffer. Maximum 20 files in the buffer at once; error if exceeded.

#### `/context list`

- **Where**: Thread only
- **Args**: None
- **Behavior**: Show all files currently in the context buffer as an ephemeral reply. Show "No files in context buffer." if empty.

#### `/context clear`

- **Where**: Thread only
- **Args**: None
- **Behavior**: Clear the context buffer for this thread. Ephemeral confirmation.

**Context buffer behavior:**
- **Runtime-only**: Stored in memory per thread. Not persisted to state.json -- if the bot restarts, the buffer is lost (acceptable since it is transient).
- **Consumed on send**: When the message handler processes a thread message and the thread has a non-empty context buffer, it reads each buffered file from the project path, builds `FilePartInput` entries (using `file://` URLs), includes them in the `parts` array alongside the `TextPartInput` for the message text, and clears the buffer after sending.
- **Cleared on cleanup**: Buffer is also cleared on `/end`, `/interrupt`, or thread deletion.

---

## Autocomplete

Discord slash command options marked with **autocomplete** use Discord's autocomplete interaction to suggest values as the user types. The bot must respond within 3 seconds.

### How It Works

**Agent/model autocomplete:**
1. **Server is running**: Query `client.app.agents()` or `client.config.providers()`, filter by user input and `allowedAgents` config, return up to 25 matches.
2. **Server is NOT running**: Serve from cache (see below). No server is started for autocomplete -- the 3-second timeout is too tight for a cold start.

**Session autocomplete (for `/connect`):**
1. **Server is running**: Query `client.session.list()`, filter out sessions already attached to an active thread (check state.json), sort by most recently active, filter by user input (prefix match on title), return up to 25 matches. Display session title; submit session ID.
2. **Server is NOT running**: Serve from cache if available. Session list is cached alongside agents/models on server start and refreshed periodically.

**File path autocomplete:**
- Resolve the deepest complete directory from the user's input relative to the project root.
- List contents via `fs.readdir` (always fast, no server needed), filter by partial segment (prefix match).
- Directories first (with trailing `/`), then files, alphabetically. Up to 25 results. Include dotfiles.
- Reject paths escaping the project root. `/ls` shows directories only; `/cat` and `/download` show both.

**Git branch autocomplete:**
1. Run `git branch --format='%(refname:short)'` in the project directory.
2. Filter by user input (prefix match).
3. Return up to 25 results.
4. Used by `/git checkout`.

### Cache Strategy

- **Population**: On every server start, and periodically while running, the bot fetches agents, models, sessions, and MCP status and caches them in-memory per project.
- **Persistence**: Cache is written to disk (e.g. `.cache/<projectPath-hash>.json`) so it survives bot restarts.
- **Autocomplete source**: Always served from cache for speed.
- **Cold cache**: If no cache exists yet (first ever use of a project), autocomplete returns empty results. The user can still type a value manually.
- **Validation**: Regardless of autocomplete, the actual agent/model value is always validated against the live server when the command executes. If validation fails, the user gets a clear error.

### Autocomplete-Enabled Options

| Command | Option | Source |
|---------|--------|--------|
| `/new` | `agent` | Cached agents, filtered by `allowedAgents` |
| `/connect` | `session` | Cached sessions, filtered to exclude already-attached sessions |
| `/agent set` | `agent` | Cached agents, filtered by `allowedAgents` |
| `/model set` | `model` | Cached models |
| `/ls` | `path` | Local filesystem (`fs.readdir`), directories only |
| `/cat` | `file` | Local filesystem (`fs.readdir`), files and directories |
| `/download` | `file` | Local filesystem (`fs.readdir`), files and directories |
| `/git checkout` | `branch` | Local git branches (`git branch`) |
| `/mcp reconnect` | `name` | Cached MCP status keys (`client.mcp.status()`) |
| `/mcp disconnect` | `name` | Cached MCP status keys (`client.mcp.status()`) |
| `/revert` | `message` | Last 15 assistant messages from `session.messages()` |
| `/fork` | `message` | Recent messages from `session.messages()` |
| `/summary` | `model` | Cached models |
| `/context add` | `file1`-`file5` | Local filesystem (`fs.readdir`), files and directories |

---

## OpenCode Server Management

### One Server Per Project

The bot manages one `opencode serve` process per unique `projectPath` across the entire config. Multiple channels/threads mapping to the same project share a single server instance.

### Server Lifecycle

Servers transition through: **Idle -> Starting -> Running -> Idle**. Any command needing the server triggers a start; 5 minutes after the last session ends, the server shuts down. **Exception**: projects with at least one `autoConnect: true` channel keep their server running as long as the bot is running (see below).

1. **Start trigger**: Any command that needs the server (`/new`, `/connect`, `/agent list`, `/model list`, or a message in a thread needing reconnection). Additionally, on bot startup, servers are started eagerly for projects that have an `autoConnect` channel (see Eager Start for Auto-Connect below).
2. **Spawning**: `createOpencode()` from the SDK, started in the project's directory on an auto-assigned port.
3. **Health check**: Wait for `GET /global/health` to return successfully before proceeding.
4. **Running**: Shared by all channels/threads mapped to that `projectPath`. All sessions for that project live on this server.
5. **Active session tracking**: The bot tracks a count of active sessions per server (from state.json, incremented on `/new`, decremented on `/end`, inactivity timeout, or thread deletion).
6. **Periodic health monitoring**: While running, the bot pings `GET /global/health` every 60 seconds. If 3 consecutive checks fail, the server is treated as crashed (notify threads, mark stopped, restart immediately if `autoConnect` is enabled for the project, otherwise restart on next use).
7. **Idle timer**: When the last active session for a project ends, a **5-minute grace period** starts. **The idle timer is suppressed for projects with at least one `autoConnect: true` channel** -- these servers stay running indefinitely to listen for `session.created` events.
8. **Shutdown**: If no new sessions or server-requiring commands arrive within 5 minutes, the server process is killed and the port is released. Does not apply to `autoConnect` projects.
9. **Restart**: The next command that needs the server transparently starts it again. For `autoConnect` projects, the server is also restarted immediately after a crash (no user interaction required).

### Eager Start for Auto-Connect

Projects with at least one `autoConnect: true` channel require an always-on server to listen for `session.created` SSE events. These servers are started eagerly:

- **On bot startup**: After config validation and state recovery, start servers for all projects that have an `autoConnect` channel (if not already running from state recovery). Subscribe to SSE and begin listening for `session.created` events immediately.
- **On crash**: If an `autoConnect` project's server crashes (detected via process exit or health check failure), restart it immediately rather than waiting for the next user interaction.
- **Idle timer bypass**: The 5-minute idle shutdown is skipped for these projects. The server stays running as long as the bot is running.

### Port Management

Ports are allocated dynamically and tracked per server. Strategy:

1. **Allocation**: Use `net.createServer()` bound to port `0` to let the OS assign a free port. Read the assigned port from `server.address().port`, close the temporary server, then immediately pass that port to `opencode serve --port=<port>`. This avoids manual range tracking and eliminates port collisions.
2. **Tracking**: The assigned port is persisted in state.json per project (for reconnection after bot restart).
3. **Release**: On server shutdown, the port entry in state.json is cleared. The OS reclaims the port immediately after the process exits.
4. **Reconnection**: On bot restart, state.json contains the port a server was last using. If the process is still alive, reconnect to that port. If not, allocate a new port on next start.

### Cache Update on Start

Every time a server starts (or restarts), the bot:
1. Fetches available agents via `client.app.agents()`.
2. Fetches available models via `client.config.providers()`.
3. Fetches existing sessions via `client.session.list()`.
4. Fetches MCP status via `client.mcp.status()`.
5. Updates the in-memory and on-disk cache for that project.

### Process Crash Handling

- If a server process crashes unexpectedly, the bot detects it (process exit event).
- If a server becomes unresponsive without crashing (zombie), periodic health checks detect it after 3 consecutive failures.
- All threads using that project are notified with an error message.
- Server is marked as `stopped` in state.json.
- The next interaction with any of those threads triggers a server restart.

### Bot Shutdown

On SIGINT/SIGTERM:
1. Abort all in-progress sessions.
2. Kill all managed `opencode serve` processes.
3. Update state.json: mark all servers as `stopped`.
4. Disconnect the Discord client.

---

## Architecture

### Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js + TypeScript |
| Package manager | pnpm |
| Discord library | discord.js v14 |
| OpenCode integration | `@opencode-ai/sdk` |
| Config format | YAML (`yaml` package) |
| Config watching | `chokidar` |
| Table rendering | `satori` + `@resvg/resvg-js` |
| Build | `tsup` or `tsc` |

### Project Structure

```
opencode-discord/
+-- src/
|   +-- index.ts                        # Entry point
|   +-- config/
|   |   +-- loader.ts                   # YAML loading, validation, hot-reload
|   |   +-- schema.ts                   # Zod schema for config validation
|   |   +-- types.ts                    # TypeScript types for config
|   +-- state/
|   |   +-- manager.ts                  # StateManager: load, save (atomic), typed accessors
|   |   +-- types.ts                    # BotState, ServerState, SessionState types
|   +-- discord/
|   |   +-- client.ts                   # Discord.js client setup
|   |   +-- deploy.ts                   # Slash command registration/deployment
|   |   +-- commands/
|   |   |   +-- index.ts                # Command registry
|   |   |   +-- new.ts                  # /new command
|   |   |   +-- connect.ts              # /connect command
|   |   |   +-- agent.ts               # /agent set, /agent list
|   |   |   +-- model.ts               # /model set, /model list
|   |   |   +-- interrupt.ts            # /interrupt
|   |   |   +-- queue.ts               # /queue list, /queue clear
|   |   |   +-- info.ts                # /info
|   |   |   +-- end.ts                 # /end
|   |   |   +-- status.ts              # /status
|   |   |   +-- help.ts                # /help
|   |   |   +-- git.ts                 # /git (all subcommands)
|   |   |   +-- ls.ts                  # /ls
|   |   |   +-- cat.ts                 # /cat
|   |   |   +-- download.ts            # /download
|   |   |   +-- restart.ts             # /restart
|   |   |   +-- mcp.ts                 # /mcp list, /mcp reconnect, /mcp disconnect
|   |   |   +-- diff.ts                # /diff (session diff)
|   |   |   +-- revert.ts              # /revert, /unrevert
|   |   |   +-- summary.ts             # /summary (summarize + compact)
|   |   |   +-- fork.ts                # /fork (fork session into new thread)
|   |   |   +-- todo.ts                # /todo (agent task list)
|   |   |   +-- retry.ts               # /retry (revert + resend last prompt)
|   |   |   +-- context.ts             # /context add, /context list, /context clear
|   |   +-- handlers/
|   |       +-- interactionHandler.ts   # Route slash commands + autocomplete
|   |       +-- messageHandler.ts       # Thread passthrough messages
|   +-- opencode/
|   |   +-- serverManager.ts            # Spawn/track/kill opencode serve per project
|   |   +-- sessionBridge.ts            # Session lifecycle, prompt sending
|   |   +-- streamHandler.ts            # SSE events -> Discord message edits
|   |   +-- questionHandler.ts          # Handle question.asked events, collect answers, reply/reject
|   |   +-- permissionHandler.ts        # Handle permission.asked events, auto-grant or interactive buttons
|   |   +-- attachments.ts              # Download, store, and cleanup Discord attachments
|   |   +-- cache.ts                    # Agent/model cache (memory + disk)
|   +-- queue/
|   |   +-- messageQueue.ts             # Per-thread in-memory message queue
|   +-- utils/
|       +-- errors.ts                   # Structured error codes and error classes
|       +-- formatter.ts                # Format opencode output for Discord (markdown, message splitting)
|       +-- tableRenderer.ts            # Render markdown tables as PNG images (satori + resvg)
|       +-- filesystem.ts              # File path autocomplete, directory listing, path security
|       +-- permissions.ts              # Check allowedUsers, allowAgentSwitch, allowedAgents
|       +-- logger.ts                   # Structured logging with correlation IDs
+-- .cache/                             # Agent/model cache files (gitignored)
+-- config.yaml                         # Actual config (gitignored)
+-- config.example.yaml                 # Example/reference config (committed)
+-- state.json                          # Runtime state (gitignored)
+-- package.json
+-- tsconfig.json
+-- .gitignore
```

---

## Error Handling

### Structured Error Codes

All user-facing errors use a consistent error code system for clear messaging and debuggability.

| Code | Meaning |
|------|---------|
| `CONFIG_INVALID` | Config file failed schema validation |
| `CONFIG_CHANNEL_NOT_FOUND` | Channel ID not in config |
| `PERMISSION_DENIED` | User not in `allowedUsers` |
| `AGENT_NOT_FOUND` | Agent doesn't exist on the server |
| `AGENT_SWITCH_DISABLED` | `allowAgentSwitch` is false |
| `AGENT_NOT_ALLOWED` | Agent not in `allowedAgents` |
| `MODEL_NOT_FOUND` | Model doesn't exist on the server |
| `SERVER_START_FAILED` | `opencode serve` failed to start |
| `SERVER_UNHEALTHY` | Health check failed |
| `SESSION_NOT_FOUND` | Thread has no active session, or session unexpectedly missing from OpenCode server |
| `SESSION_ALREADY_ATTACHED` | Session is already linked to another active thread |
| `PATH_ESCAPE` | File path attempted to escape project root |
| `FILE_NOT_FOUND` | Requested file doesn't exist |
| `GIT_DIRTY` | Uncommitted changes prevent checkout |
| `GIT_CONFLICT` | Git operation resulted in conflicts |
| `DISCORD_API_ERROR` | Discord API call failed |
| `MCP_NOT_FOUND` | MCP server name not found in status |
| `MCP_CONNECT_FAILED` | MCP reconnect/disconnect failed |
| `CONTEXT_BUFFER_FULL` | Context buffer exceeds 20 files |
| `NO_MESSAGE_TO_RETRY` | No previous user message for `/retry` |
| `NO_MESSAGE_TO_REVERT` | No assistant message to revert |
| `FORK_FAILED` | Session fork failed |
| `QUESTION_INVALID_ANSWER` | User's answer to agent question is invalid (letter out of range, text when custom disabled) |
| `QUESTION_TIMEOUT` | Agent question timed out without an answer |
| `PERMISSION_TIMEOUT` | Permission request timed out without a response |

### Correlation IDs

Every interaction (slash command, message passthrough, autocomplete) generates a correlation ID in the format `<threadId>-<timestamp>`. This ID is:
- Included in all log entries for that interaction
- Included in error messages shown to users (for support/debugging)
- Passed through to the server manager and session bridge

---

## Formatting & Message Delivery

### Discord Markdown Compatibility

Discord supports a **subset** of markdown, not the full CommonMark spec. OpenCode agents produce standard markdown, so `formatter.ts` must convert output for Discord compatibility.

**Supported by Discord:**
- Bold (`**text**`), italic (`*text*`), underline (`__text__`), strikethrough (`~~text~~`)
- Inline code (`` `code` ``)
- Fenced code blocks (` ```lang ... ``` `) with syntax highlighting
- Block quotes (`> text`)
- Ordered and unordered lists (basic)
- Headings (`#`, `##`, `###`)
- Links (URLs auto-embed; `[text](url)` renders but differently than standard markdown)

**Not supported or problematic:**
- **Tables** -- rendered as raw text, not formatted grids
- **Images** via `![alt](url)` -- not rendered inline
- Nested lists beyond ~2 levels
- HTML tags
- Horizontal rules (`---`) render inconsistently

### Message Splitting Strategy

Long responses are split across multiple Discord messages. No file attachment fallback -- always multi-message.

- **Split boundary**: Smart -- when approaching ~1800 chars, find the nearest clean boundary (paragraph break, newline, end of code block).
- **Code block continuity**: If a split occurs inside a fenced code block, close it with ` ``` ` in the current message and re-open it (with the same language tag) in the next message. This preserves syntax highlighting.
- **No upper limit** on message count.
- **Table handling**: Tables are rendered as images (see Table Rendering section below).

### Streaming Flow

1. Create an initial Discord message and begin editing it as tokens arrive via SSE.
2. As content approaches ~1800 chars, look for a clean split point (paragraph break, newline, end of code block).
3. If currently inside a fenced code block, close it with ` ``` `.
4. Finalize the current message (stop editing).
5. Create a new Discord message. Re-open the code block (with the same language tag) if the split happened mid-block.
6. Continue streaming into the new message.
7. If a markdown table is detected during streaming, buffer it until complete, then send as its own message (see Table Rendering).
8. If `ToolPart` events arrive, show inline tool status at the bottom of the current message (see Tool Status Display below).
9. If a `question.asked` event arrives, pause streaming and post question embeds (see Special Agent Messages section).
10. If a `permission.asked` event arrives, handle per channel config (see Special Agent Messages section).
11. Repeat as needed.

### SSE Stream Resilience

On SSE disconnect, retry up to 3 times within 5 seconds. On success, post "*reconnected*" inline. On failure, post an error message in the thread. Partial messages already sent are left as-is.

### Table Rendering

Discord does not render markdown tables. Tables are detected during streaming, rendered as dark-themed PNG images, and sent as their own Discord message.

**Detection** uses a state machine during streaming: normal -> maybe-table (line matching `| ... |`) -> table (if next line is `|---|` separator) -> complete (non-table line or end of stream). This handles SSE chunks splitting table lines across events. Non-table `| ... |` lines are flushed as normal text.

**Rendering stack**: `satori` (HTML/CSS -> SVG) + `@resvg/resvg-js` (SVG -> PNG). No headless browser required. When a table completes: parse into structured data, render as styled HTML table, convert to PNG, send as a Discord message with the image attached and raw markdown in a spoiler tag (`||...||`) as fallback.

**Styling**: Dark theme matching Discord -- background `#2b2d31`, text `#e0e0e0`, grid lines `#40444b`, bold/lighter header row.

### Tool Status Display

During streaming, `ToolPart` events are used to show lightweight inline status of tool execution:

- When a `ToolPart` with `status: "running"` arrives, append a status line at the bottom of the current Discord message: `⏳ bash, read_file`
- Multiple concurrent tools are shown comma-separated on the same line.
- As tools complete (`status: "completed"`) or fail (`status: "error"`), they are removed from the running list.
- When text streaming resumes after all tools finish, the status line is removed from the message.
- **Granularity**: Tool name only -- no input preview or output details.
- The status line is updated on the same throttle cycle as text edits (~1s).

### Throttling & Deduplication

- Minimum ~1 second between Discord message edits to avoid rate limits. On edit failures, fall back to a new message.
- Show typing indicator while the agent is processing.
- Message deduplication: LRU cache of last 100 message IDs per thread to silently drop duplicate Discord events.

---

## Special Agent Messages

OpenCode agents can emit interactive events that require user input beyond regular text prompts. The bot handles three categories: questions, permission requests, and tool status (covered above in Streaming Flow).

### Questions (`question.asked`)

Agents can ask the user multiple-choice questions via the `question` tool. These arrive as `question.asked` SSE events containing one or more questions, each with a header, question text, options (label + description), and flags for multi-select and custom answers.

#### Display

Each question in a group is posted as a separate Discord embed, sequentially (one at a time). Format:

```
📋 Header Text

Question text here?

a) Option Label — Option description
b) Option Label — Option description
c) Option Label — Option description

Reply with a letter, or type a custom answer.
```

Footer variants based on flags:
- Default (`multiple: false`, `custom: true`): "Reply with a letter, or type a custom answer."
- `multiple: true`, `custom: true`: "Reply with one or more letters (comma-separated), or type a custom answer."
- `multiple: false`, `custom: false`: "Reply with a letter."
- `multiple: true`, `custom: false`: "Reply with one or more letters (comma-separated)."

#### Answer Processing

For multi-question groups, answers are collected sequentially -- one user message per question. After each answer is received, the next question embed is posted. Once all answers are collected, `client.question.reply({ requestID, answers })` is called with all answers at once.

Answer parsing:
- Letter input (`a`, `b,c`) → validated against option count → mapped to corresponding option labels → collected as `[label1, label2, ...]`
- Text input (when `custom: true`) → collected as `[userText]`
- Invalid input (letter out of range, text when `custom: false`) → reply with ephemeral error, re-show the same question

#### Pending Question State

Stored per-thread in runtime memory (not persisted -- if the bot restarts mid-question, the agent times out):

```ts
pendingQuestion: {
  requestID: string;
  questions: QuestionInfo[];
  currentIndex: number;        // which question we're currently showing
  collectedAnswers: string[][]; // answers collected so far
} | null
```

#### Message Handler Integration

When a thread has a pending question, the next non-bot message is intercepted by the message handler and treated as a question answer instead of being forwarded as a prompt. While a question is pending, any additional messages beyond the first are queued normally -- they are not treated as answers.

#### Timeout

Configurable per-channel via `questionTimeout` (default: 300 seconds / 5 minutes). After timeout with no answer, auto-reject via `client.question.reject({ requestID })` and post: "Question timed out. The agent will continue without an answer."

The timeout applies to the entire question group, not per-question. The timer resets after each answer within a group.

#### Queue Interaction

- If the agent is in the middle of streaming a response and a question arrives, the current stream is paused (the question event interrupts it).
- The question embed(s) are posted after the current message.
- After the question is answered (or timed out), streaming resumes normally.

### Permissions (`permission.asked`)

Agents request permission for operations (file writes, bash execution, etc.) via `permission.asked` SSE events. Handling is configurable per-channel.

#### Config

```yaml
channels:
  "123456789":
    permissions: "auto"  # "auto" (default) | "interactive"
```

#### `auto` Mode (Default)

When a `permission.asked` event arrives, immediately reply `"always"` via `client.permission.reply({ requestID, reply: "always" })`. No Discord message is posted. This is the expected behavior for headless/CI-like setups where agents operate with full trust.

#### `interactive` Mode

Post an embed with Discord buttons:

```
⚠️ Permission Request

The agent wants to: write
Patterns: src/**/*.ts, tests/**/*.ts

[Allow Once] [Allow Always] [Reject]
```

- **Allow Once**: `client.permission.reply({ requestID, reply: "once" })`
- **Allow Always**: `client.permission.reply({ requestID, reply: "always" })`
- **Reject**: `client.permission.reply({ requestID, reply: "reject" })`
- **Timeout**: 60 seconds → auto-reject via `client.permission.reply({ requestID, reply: "reject" })`, post notice: "Permission request timed out. Request rejected."
- While waiting for a response, the agent is blocked -- no special queue handling is needed.

---

## Attachment Handling

### Input: Discord -> OpenCode

User attachments in thread messages are forwarded to OpenCode via `FilePartInput` in the `parts` array.

1. Download all attachments immediately (Discord URLs expire).
2. Save to `<projectPath>/.opencode/attachments/<timestamp>-<discord-message-id>-<original-filename>`.
3. Send prompt with `parts` array: `TextPartInput` for the message text, `FilePartInput` for each attachment (using `file://` URL to the saved file).
4. All file types sent as `FilePartInput` regardless of type -- OpenCode handles unsupported types gracefully. No size cap.

### Output: OpenCode -> Discord

- **`FilePart` SSE events**: Download/decode and attach to the Discord reply via `AttachmentBuilder`.
- **`ToolStateCompleted.attachments`**: Detected and attached to the reply.
- **Agent text references**: After response completes, scan for local file path references (`.png`, `.jpg`, `.svg`, `.gif`, `.webp`). Verify existence under project path and attach.

### Attachment Storage

- **Location**: `<projectPath>/.opencode/attachments/`
- **Naming convention**: `<timestamp>-<discord-message-id>-<original-filename>` to avoid collisions.
- **Cleanup**: TTL-based (files older than 24 hours deleted on bot startup and periodically) plus session-based cleanup on `/end`.
- **Gitignore**: The `.opencode/` directory is already gitignored by OpenCode convention.

---

## Auto-Connect

### Overview

When `autoConnect` is enabled for a channel, the bot automatically creates a Discord thread and connects to any new OpenCode session created on the channel's project -- regardless of how the session was created (TUI, CLI, external scheduler, another SDK client, etc.). This enables fully hands-off operation where external tools create sessions and the bot surfaces them in Discord.

### Config

```yaml
channels:
  - channelId: "123456789012345678"
    projectPath: "/path/to/project"
    autoConnect: true  # (optional, default: false)
```

- **Type**: `boolean`, optional, default `false`
- **Constraint**: At most one channel per `projectPath` should have `autoConnect: true`. If multiple channels for the same project enable it, the bot logs a warning on startup and uses the first one found.

### Mechanism

The bot subscribes to SSE events per running server. When a `session.created` event arrives:

1. Identify the project from `GlobalEvent.directory`.
2. Find the channel with `autoConnect: true` for that project. If none, ignore.
3. Check if the session is already attached to a Discord thread in state.json. If so, skip (it was created by `/new` or `/connect`).
4. Execute the shared connect flow (same as `/connect` -- see Session History Replay & Gap Recovery above): create thread, persist mapping, subscribe to SSE, replay history, gap recovery, post confirmation ("Auto-connected to session `<sessionId>`.").

### Edge Cases

- **Session created by `/new`**: The bot creates the session itself and attaches it to a thread before the `session.created` event fires. Step 4 filters this out.
- **SSE reconnection gap**: If the SSE connection drops and reconnects, sessions created during the gap are missed. On SSE reconnect, a quick `session.list()` diff against known sessions catches any missed sessions and auto-connects them.
- **Bot restart**: During startup recovery, after reconnecting to servers and recovering existing sessions, a `session.list()` diff detects sessions created while the bot was offline and auto-connects them to channels with `autoConnect: true`.
- **Server not running**: If no server is running, there are no SSE events. When the server starts (triggered by any interaction), the bot subscribes to SSE and the initial `session.list()` cache population catches existing unattached sessions.
- **Multiple channels, same project**: Only the channel with `autoConnect: true` receives auto-created threads. Other channels for the same project are unaffected and can still use `/connect` manually.

### Startup Validation

During config validation, if multiple channels for the same `projectPath` have `autoConnect: true`, log a warning and use the first one found. This is a config error but not fatal.

---

## Thread Lifecycle

- **Discord auto-archive**: The bot does NOT unarchive threads automatically. Users can manually unarchive to continue.
- **24h inactivity**: Sessions are marked `inactive`, thread is archived, session mapping retained. Reconnects on unarchive (see State Persistence > Reconnection on Unarchive).
- **Thread deletion**: Bot detects `threadDelete`, aborts any in-progress task, marks session `ended`, decrements active session count.

---

See [`IMPLEMENTATION.md`](IMPLEMENTATION.md) for the multi-agent execution strategy, implementation steps, SDK reference, and dependencies.
