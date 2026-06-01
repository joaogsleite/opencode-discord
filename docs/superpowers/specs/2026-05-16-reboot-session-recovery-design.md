# Reboot Session Recovery Design

## Goal

After a full machine reboot, users should be able to continue sending messages in existing Discord session threads when the backing OpenCode session still exists. If the backing session cannot be recovered, the bot must tell the thread clearly instead of failing silently.

## Current Behavior

Startup loads persisted `state.json`, recovers healthy `opencode serve` processes, and resubscribes active sessions when a client is available. If a server is dead, recovery can skip sessions until a server is started later. The runtime message path starts the project server on demand before forwarding a thread message, but prompt failures from missing OpenCode sessions can be silent because `messageCreate` dispatch is fire-and-forget.

## Proposed Behavior

On a message in a persisted active Discord thread:

1. Ensure the project server is running with `serverManager.ensureRunning(session.projectPath)`.
2. Before `promptAsync`, verify the persisted `sessionId` with `client.session.get({ sessionID })`.
3. If verification succeeds, refresh the stream subscription and send the prompt normally.
4. If verification fails or returns no session, mark the mapping `ended`, clear queued messages for that thread, and notify the Discord thread that the previous OpenCode session could not be recovered after restart.
5. Catch message handler failures at the Discord runtime boundary, log them, and send a bounded user-facing thread notice when possible.

## Scope

This does not recreate missing OpenCode sessions automatically. It preserves existing sessions when possible and fails explicitly when OpenCode has lost the session.

## Testing

Add tests for:

- Post-reboot message to an existing thread verifies the OpenCode session and calls `promptAsync` when the session exists.
- Missing OpenCode session marks the Discord mapping ended and notifies the thread instead of silently ignoring the message.
- Runtime `messageCreate` catches unexpected forwarding failures and posts a bounded failure notice.

## Acceptance Criteria

- Full reboot with persisted OpenCode session: existing Discord thread continues normally.
- Full reboot with missing OpenCode session: existing Discord thread gets a clear recovery failure notice.
- `pnpm tsc --noEmit && pnpm test` passes.
