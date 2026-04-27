---
name: sdk-reference
description: OpenCode SDK v2 API calling conventions, SSE event types, key TypeScript types, server spawning with cross-spawn, and streaming patterns
---

## Import Path

Always use the v2 API surface:

```ts
import { createOpencode, createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"
import type { GlobalEvent, Event, Session, Part, TextPartInput, FilePartInput } from "@opencode-ai/sdk/v2"
```

The root import (`@opencode-ai/sdk`) is legacy v1 -- missing `question`, `permission.reply`, `global.health`, and other methods required by this project. Never use it.

## Server Spawning with Custom cwd

`createOpencodeServer()` does not accept a `cwd` option. Spawn servers directly:

```ts
import launch from "cross-spawn"

const proc = launch("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
  cwd: projectPath,
  env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}) },
})
// Parse stdout for "opencode server listening on <url>"
// Then connect: createOpencodeClient({ baseUrl: url })
```

## v2 API Calling Convention

Flat named parameters (not nested path/body/query objects):

```ts
// Session operations
client.session.create({ title: "My session" })
client.session.get({ sessionID: "sess_abc" })
client.session.abort({ sessionID: "sess_abc" })
client.session.messages({ sessionID: "sess_abc", limit: 10 })
client.session.promptAsync({ sessionID: "sess_abc", parts: [...], agent: "build" })
client.session.fork({ sessionID: "sess_abc", messageID: "msg_xyz" })
client.session.revert({ sessionID: "sess_abc", messageID: "msg_xyz" })
client.session.unrevert({ sessionID: "sess_abc" })
client.session.summarize({ sessionID: "sess_abc", providerID: "anthropic", modelID: "claude-sonnet-4-20250514" })
client.session.diff({ sessionID: "sess_abc" })
client.session.todo({ sessionID: "sess_abc" })

// Permissions
client.permission.reply({ requestID: "req_abc", reply: "always" })
client.permission.list()

// Questions
client.question.reply({ requestID: "req_abc", answers: [["label1"], ["label2", "label3"]] })
client.question.reject({ requestID: "req_abc" })
client.question.list()

// MCP
client.mcp.status()                           // → { [name: string]: McpStatus }
client.mcp.connect({ name: "my-mcp" })        // → boolean
client.mcp.disconnect({ name: "my-mcp" })     // → boolean

// Health
client.global.health()                        // → { healthy: true }

// Agents & models
client.app.agents()                           // → Agent[]
client.config.providers()                     // → { providers, default }
```

## SSE Event Stream

Subscribe via `client.global.event()`. Each event is a `GlobalEvent`:

```ts
type GlobalEvent = {
  directory: string
  project?: string
  workspace?: string
  payload: Event  // discriminated union on payload.type
}
```

Key event types:

| Event Type | Purpose | Key Fields |
|---|---|---|
| `message.part.delta` | Text streaming | `sessionID`, `messageID`, `partID`, `field`, `delta` |
| `message.part.updated` | Part state change | `part: Part` (full Part object) |
| `message.updated` | Message metadata | `info: Message` |
| `message.removed` | Message reverted | `sessionID`, `messageID` |
| `session.created` | Auto-connect trigger | `info: Session` |
| `session.status` | Busy/idle/retry | `sessionID`, `status` |
| `session.idle` | Session idle | `sessionID` |
| `permission.asked` | Permission request | `PermissionRequest { id, sessionID, permission, patterns }` |
| `question.asked` | Agent question | `QuestionRequest { id, sessionID, questions }` |
| `session.error` | Error | `sessionID?`, `error` |

## Streaming Pattern

Text streaming uses deltas, NOT complete Part objects per token:
- `message.part.delta` → incremental text chunks (`delta` field). Accumulate per `partID`.
- `message.part.updated` → full `Part` object when state changes (e.g. ToolPart running → completed).

## Key Types

```ts
type TextPartInput = { type: "text"; text: string }
type FilePartInput = { type: "file"; mime: string; url: string; filename?: string }

type PermissionRequest = { id: string; sessionID: string; permission: string; patterns: string[]; metadata: unknown; always: string[] }

type QuestionRequest = { id: string; sessionID: string; questions: QuestionInfo[]; tool?: string }
type QuestionInfo = { question: string; header: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean }
type QuestionOption = { label: string; description: string }

type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
// ToolStateRunning: { status: "running", input, title?, metadata?, time: { start } }
// ToolStateCompleted: { status: "completed", input, output, title, metadata, time, attachments?: FilePart[] }

type McpStatus = McpStatusConnected | McpStatusDisabled | McpStatusFailed | McpStatusNeedsAuth | McpStatusNeedsClientRegistration
```
