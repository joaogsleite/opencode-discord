---
name: module-boundaries
description: File ownership rules, import direction constraints, and interface contracts between modules -- prevents sub-agents from stepping on each other
---

## Import Direction

```
utils/ ← config/ ← state/ ← queue/ ← opencode/ ← discord/commands/
                                         ↑
                                    discord/handlers/
```

Arrow means "may import from". Never import against the arrow direction.

Specifically:
- `utils/` imports nothing from the project (only external packages)
- `config/` imports from `utils/` only
- `state/` imports from `utils/`, `config/`
- `queue/` imports from `utils/`, `state/`
- `opencode/` imports from `utils/`, `config/`, `state/`, `queue/`
- `discord/handlers/` imports from `opencode/`, `queue/`, `state/`, `config/`, `utils/`
- `discord/commands/` imports from `opencode/`, `queue/`, `state/`, `config/`, `utils/`

NEVER:
- `opencode/` importing from `discord/`
- `config/` importing from `state/`
- `utils/` importing from any project module

## File Ownership by Sub-agent

| Scope | Files Owned |
|-------|-------------|
| Sub-agent 1 (Scaffolding) | `src/config/*`, `src/state/*`, `package.json`, `tsconfig.json`, `config.example.yaml` |
| Sub-agent 2 (Discord Core) | `src/discord/client.ts`, `src/discord/deploy.ts`, `src/discord/handlers/*` |
| Sub-agent 3 (OpenCode Integration) | `src/opencode/serverManager.ts`, `src/opencode/cache.ts`, `src/opencode/sessionBridge.ts` |
| Sub-agent 4 (Streaming) | `src/opencode/streamHandler.ts`, `src/opencode/questionHandler.ts`, `src/opencode/permissionHandler.ts`, `src/utils/formatter.ts`, `src/utils/tableRenderer.ts` |
| Sub-agent 5 (Commands 1) | `src/discord/commands/new.ts`, `connect.ts`, `agent.ts`, `model.ts`, `info.ts`, `end.ts`, `status.ts`, `help.ts`, `index.ts` |
| Sub-agent 6 (Commands 2) | `src/discord/commands/git.ts`, `ls.ts`, `cat.ts`, `download.ts`, `queue.ts`, `interrupt.ts` |
| Sub-agent 7 (Commands 3) | `src/discord/commands/restart.ts`, `mcp.ts`, `diff.ts`, `revert.ts`, `summary.ts`, `fork.ts`, `todo.ts`, `retry.ts`, `context.ts` |
| Sub-agent 8 (Utilities) | `src/utils/errors.ts`, `src/utils/filesystem.ts`, `src/utils/permissions.ts`, `src/utils/logger.ts` |
| Sub-agent 9 (Attachments) | `src/opencode/attachments.ts` |

## Interface Contracts

Modules communicate through well-defined interfaces. Each module exports a class or set of functions with typed signatures.

### Config exports (consumed by all)
```ts
export interface ConfigLoader {
  getConfig(): BotConfig
  getChannelConfig(channelId: string): ChannelConfig | undefined
  onChange(callback: (config: BotConfig) => void): void
}
```

### State exports (consumed by opencode/, discord/, queue/)
```ts
export interface StateManager {
  getSession(threadId: string): SessionState | undefined
  setSession(threadId: string, session: SessionState): void
  removeSession(threadId: string): void
  getServer(projectPath: string): ServerState | undefined
  setServer(projectPath: string, server: ServerState): void
  getQueue(threadId: string): QueueEntry[]
  setQueue(threadId: string, entries: QueueEntry[]): void
  save(): void
}
```

### OpenCode exports (consumed by discord/handlers/, discord/commands/)
```ts
export interface ServerManager {
  ensureRunning(projectPath: string): Promise<OpencodeClient>
  getClient(projectPath: string): OpencodeClient | undefined
  shutdown(projectPath: string): Promise<void>
  shutdownAll(): Promise<void>
}

export interface CacheManager {
  getAgents(projectPath: string): Agent[]
  getModels(projectPath: string): Provider[]
  getSessions(projectPath: string): Session[]
  getMcpStatus(projectPath: string): Record<string, McpStatus>
  refresh(projectPath: string): Promise<void>
}

export interface SessionBridge {
  createSession(opts: CreateSessionOpts): Promise<SessionState>
  sendPrompt(threadId: string, parts: PartInput[], opts?: PromptOpts): Promise<void>
  connectToSession(opts: ConnectOpts): Promise<void>
  abortSession(threadId: string): Promise<void>
}
```

### Stream handler exports (consumed by discord/handlers/)
```ts
export interface StreamHandler {
  subscribe(threadId: string, sessionId: string): void
  unsubscribe(threadId: string): void
}

export interface QuestionHandler {
  hasPendingQuestion(threadId: string): boolean
  handleQuestionAnswer(threadId: string, content: string): Promise<void>
  clearPending(threadId: string): void
}
```

## Sub-agent Rules

1. **Only modify files in your assigned scope** -- if you need something from another module, import it
2. **Export typed interfaces** -- downstream modules depend on your types
3. **Never implement another module's responsibility inline** -- define the interface, import when available
4. **Use stub/placeholder types if a dependency isn't built yet** -- enables parallel implementation
