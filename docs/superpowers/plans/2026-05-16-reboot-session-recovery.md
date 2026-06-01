# Reboot Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue existing Discord threads after a full reboot when the OpenCode session still exists, and notify clearly when it does not.

**Architecture:** Add verification before prompt forwarding in `SessionBridge.sendPrompt` by calling `session.get`. Contain missing-session recovery in `handleMessageCreate`, where state can be marked ended and queues cleared. Catch runtime message failures at the Discord event boundary and post a bounded notice.

**Tech Stack:** Node.js, TypeScript, discord.js v14, @opencode-ai/sdk/v2, vitest.

---

## File Map

- Modify `src/opencode/sessionBridge.ts`: verify an active OpenCode session exists before `promptAsync`.
- Modify `src/opencode/sessionBridge.test.ts`: add verification success and missing-session tests.
- Modify `src/discord/handlers/messageHandler.ts`: mark missing sessions ended, clear queues, and notify thread.
- Modify `src/discord/handlers/messageHandler.test.ts`: add missing-session recovery test.
- Modify `src/index.ts`: catch fire-and-forget `messageCreate` failures and notify the thread.
- Modify `src/index.test.ts`: add runtime boundary failure test.

## Task 1: Verify Session Before Prompt

**Files:**
- Modify: `src/opencode/sessionBridge.ts`
- Test: `src/opencode/sessionBridge.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests asserting `sendPrompt` calls `session.get` before `promptAsync`, and throws `SESSION_NOT_FOUND` without calling `promptAsync` when `session.get` returns `null`.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run src/opencode/sessionBridge.test.ts`

Expected: at least one new test fails because `sendPrompt` does not verify with `session.get`.

- [ ] **Step 3: Implement minimal code**

In `SessionBridge.sendPrompt`, call `await this.verifySession(options.client, session.sessionId)` before `refreshSubscription` and `promptAsync`.

- [ ] **Step 4: Run GREEN**

Run: `pnpm vitest run src/opencode/sessionBridge.test.ts`

Expected: all `SessionBridge` tests pass.

## Task 2: Recover Missing Session In Message Handler

**Files:**
- Modify: `src/discord/handlers/messageHandler.ts`
- Test: `src/discord/handlers/messageHandler.test.ts`

- [ ] **Step 1: Write failing test**

Add a test where `sessionBridge.sendPrompt` throws `BotError(ErrorCode.SESSION_NOT_FOUND)`. Expect `stateManager.setSession(threadId, { ...session, status: 'ended' })`, `stateManager.clearQueue(threadId)`, and `message.channel.send(...)` with a recovery failure notice.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run src/discord/handlers/messageHandler.test.ts`

Expected: the new test fails because missing-session errors currently propagate silently to the runtime caller.

- [ ] **Step 3: Implement minimal code**

Extend the structural state manager type used by tests to include `clearQueue`. Catch `SESSION_NOT_FOUND` from `sendPrompt`, mark the stored session ended, clear queue, and send a bounded thread notice.

- [ ] **Step 4: Run GREEN**

Run: `pnpm vitest run src/discord/handlers/messageHandler.test.ts`

Expected: all message handler tests pass.

## Task 3: Catch Runtime Message Failures

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts`

- [ ] **Step 1: Write failing test**

Add a startup wiring test where a thread message causes `ensureRunning` or `promptAsync` to throw a generic error. Expect the thread receives `Failed to send message to OpenCode.` and the process does not throw from the event listener.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run src/index.test.ts`

Expected: the new test fails because `messageCreate` currently discards the promise without catch handling.

- [ ] **Step 3: Implement minimal code**

Wrap the `handleMessageCreate(...)` promise in `.catch(...)`, log the failure, and use a helper to call `message.channel.send('Failed to send message to OpenCode. *(ref: <correlation>)*')` when the message came from a thread.

- [ ] **Step 4: Run GREEN**

Run: `pnpm vitest run src/index.test.ts`

Expected: all index tests pass.

## Task 4: Full Verification

- [ ] Run: `pnpm tsc --noEmit && pnpm test`
- [ ] Expected: typecheck passes and all tests pass.
