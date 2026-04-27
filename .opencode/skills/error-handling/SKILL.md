---
name: error-handling
description: BotError class design, structured error codes, correlation IDs, user-facing error formatting, and logging conventions for the Discord bot
---

## BotError Class

All user-facing errors use a structured BotError class:

```ts
export class BotError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "BotError"
  }
}
```

Always throw BotError with a code from the enum -- never throw raw Error or strings.

## Error Codes

```ts
export enum ErrorCode {
  CONFIG_INVALID = "CONFIG_INVALID",
  CONFIG_CHANNEL_NOT_FOUND = "CONFIG_CHANNEL_NOT_FOUND",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  AGENT_NOT_FOUND = "AGENT_NOT_FOUND",
  AGENT_SWITCH_DISABLED = "AGENT_SWITCH_DISABLED",
  AGENT_NOT_ALLOWED = "AGENT_NOT_ALLOWED",
  MODEL_NOT_FOUND = "MODEL_NOT_FOUND",
  SERVER_START_FAILED = "SERVER_START_FAILED",
  SERVER_UNHEALTHY = "SERVER_UNHEALTHY",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_ALREADY_ATTACHED = "SESSION_ALREADY_ATTACHED",
  PATH_ESCAPE = "PATH_ESCAPE",
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  GIT_DIRTY = "GIT_DIRTY",
  GIT_CONFLICT = "GIT_CONFLICT",
  DISCORD_API_ERROR = "DISCORD_API_ERROR",
  MCP_NOT_FOUND = "MCP_NOT_FOUND",
  MCP_CONNECT_FAILED = "MCP_CONNECT_FAILED",
  CONTEXT_BUFFER_FULL = "CONTEXT_BUFFER_FULL",
  NO_MESSAGE_TO_RETRY = "NO_MESSAGE_TO_RETRY",
  NO_MESSAGE_TO_REVERT = "NO_MESSAGE_TO_REVERT",
  FORK_FAILED = "FORK_FAILED",
  QUESTION_INVALID_ANSWER = "QUESTION_INVALID_ANSWER",
  QUESTION_TIMEOUT = "QUESTION_TIMEOUT",
  PERMISSION_TIMEOUT = "PERMISSION_TIMEOUT",
}
```

## Correlation IDs

Every interaction generates a correlation ID:

```ts
const correlationId = `${threadId}-${Date.now()}`
```

Rules:
- Generated at the entry point (interaction handler or message handler)
- Passed through all layers via function parameters (not globals)
- Included in every log entry for that interaction
- Included in user-facing error messages

## User-Facing Error Format

```ts
// In command/message handlers:
try {
  await doWork(correlationId)
} catch (err) {
  if (err instanceof BotError) {
    await interaction.reply({
      content: `**Error:** ${err.message} *(ref: ${correlationId})*`,
      ephemeral: true,
    })
    logger.warn(err.message, { code: err.code, correlationId, ...err.context })
  } else {
    await interaction.reply({
      content: `**Unexpected error** *(ref: ${correlationId})*`,
      ephemeral: true,
    })
    logger.error("Unhandled error", { correlationId, err })
  }
}
```

Rules:
- Always ephemeral when possible (only user sees it)
- Always include the correlation ID as `ref:`
- Never expose stack traces, internal paths, or raw error objects to users
- BotError gets a warn-level log; unknown errors get error-level

## Logging Pattern

```ts
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}
```

Always structured:
```ts
logger.error("Server health check failed", {
  code: "SERVER_UNHEALTHY",
  correlationId,
  projectPath,
  consecutiveFailures: 3,
})
```

Never:
```ts
logger.error(`Server ${projectPath} failed health check`) // no structured data
```

## Graceful Degradation

Not every failure should throw BotError to the user. Non-critical failures degrade silently:

```ts
// Cache fetch fails → return empty, don't crash
try {
  agents = await client.app.agents()
} catch {
  logger.warn("Agent cache refresh failed", { projectPath, correlationId })
  agents = cachedAgents ?? []
}
```

Only throw BotError when the user's action cannot be completed.
