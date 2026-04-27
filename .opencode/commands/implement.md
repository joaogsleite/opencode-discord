---
description: Implement a round from IMPLEMENTATION.md using subagent-driven-development with two-stage review
---

Implement Round $ARGUMENTS from the project's implementation plan using the **subagent-driven-development** methodology.

## Process

### 1. Preparation

1. Read `IMPLEMENTATION.md` to identify this round's tasks, their scopes, and file ownership.
2. Read the Cross-Module Interfaces section to know what types/exports are available from prior rounds (if Round 2+, read the actual source files from prior rounds).
3. Extract the full task text for each task in this round (do NOT pass the entire IMPLEMENTATION.md to sub-agents).
4. Create a TodoWrite with all tasks for this round.

### 2. Per-Task Execution (subagent-driven-development)

For EACH task in this round:

#### a. Dispatch Implementer Sub-agent

Launch a Task sub-agent with:
- The extracted task text (full, with all code blocks and steps)
- TypeScript interfaces it must implement against (inline from prior round files)
- Exact file paths it owns (from IMPLEMENTATION.md)
- Instructions:
  - "Follow TDD: write failing test FIRST, verify it fails, then implement minimal code to pass."
  - "Only modify files in your assigned scope. Load the `module-boundaries` skill for ownership rules."
  - "Load relevant skills: `sdk-reference` for OpenCode API, `discord-patterns` for Discord, `error-handling` for errors, `process-lifecycle` for server management."
  - "Run `pnpm tsc --noEmit` and `pnpm test` at the end."
  - "Report: files created/modified, exported interfaces, test results, any concerns."

Handle implementer status:
- **DONE** → proceed to spec review
- **DONE_WITH_CONCERNS** → read concerns, address if needed, then proceed
- **NEEDS_CONTEXT** → provide missing context and re-dispatch
- **BLOCKED** → assess: provide more context, use more capable model, or break into smaller tasks

#### b. Dispatch Spec Compliance Reviewer

Launch a Task sub-agent that:
- Receives the original task spec text and the implementer's output
- Checks: Does the implementation match the spec exactly? Nothing missing? Nothing extra?
- Returns: APPROVED or list of gaps/extras to fix

If gaps found → implementer fixes → re-review until APPROVED.

#### c. Dispatch Code Quality Reviewer

Launch a Task sub-agent that:
- Receives the implemented files (read them)
- Checks against AGENTS.md conventions:
  - Named exports only, no default exports
  - `type` keyword for type-only imports
  - BotError with error codes (not raw throws)
  - Async/await (no callbacks or .then chains)
  - JSDoc on all public functions
  - Module boundary compliance (import direction)
  - State mutations call save() immediately
  - Graceful degradation for non-critical failures
- Returns: APPROVED or list of issues by severity

If issues found → implementer fixes → re-review until APPROVED.

#### d. Mark Task Complete

Update TodoWrite. Move to next task.

### 3. Round Verification

After all tasks in this round are complete:

1. Run `pnpm tsc --noEmit` to verify cross-module integration
2. Run `pnpm test` to verify all tests pass
3. If there are type errors or test failures, fix them (typically import mismatches between sub-agents)
4. Commit the round's work with a descriptive message

### 4. Report

Summarize:
- Tasks completed
- Files created/modified
- Test coverage added
- Any issues encountered and how they were resolved
- Readiness for the next round
