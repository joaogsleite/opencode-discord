# opencode-discord

Discord bot that maps channels to OpenCode agents. Multi-server, one `opencode serve` per project path, always-on thread passthrough.

## Tech Stack

- Runtime: Node.js + TypeScript (strict mode, ES2022 target)
- Package manager: pnpm
- Discord: discord.js v14
- OpenCode: @opencode-ai/sdk/v2 (ALWAYS /v2 -- the root import is legacy v1)
- Config: YAML + Zod validation
- Build: tsup
- Test: vitest

## Development Philosophy

### Test-Driven Development (Mandatory)

This project follows strict TDD. No production code without a failing test first.

1. **RED** — Write a failing test that describes the desired behavior
2. **Verify RED** — Run the test, confirm it fails for the expected reason (missing implementation, not typo)
3. **GREEN** — Write the minimal code to make the test pass
4. **Verify GREEN** — Run the test, confirm it passes along with all other tests
5. **REFACTOR** — Clean up while keeping tests green
6. **COMMIT** — Frequent, small commits after each green cycle

**Violations:** If code was written before its test, delete it. Write the test first, then reimplement from scratch. No exceptions.

**What to test per module:**
- `config/` — Schema validation (valid, invalid, edge cases), hot-reload events, default values
- `state/` — Load/save cycle, atomic write guarantees, concurrent access, accessor correctness
- `queue/` — Enqueue/dequeue ordering, deduplication, clear, persistence
- `opencode/` — Server start/stop/crash, cache invalidation, session lifecycle, SSE event handling
- `discord/commands/` — Permission checks, argument validation, response format, error paths
- `utils/` — Path security, formatter splitting, table detection, error construction

### YAGNI & DRY

- Don't implement features not explicitly specified in PLAN.md
- Don't add "nice-to-have" parameters, options, or abstractions
- Extract shared logic only after the second occurrence (not preemptively)
- If the plan doesn't ask for it, don't build it

### Complexity Reduction

- Prefer simple, obvious solutions over clever ones
- Smaller files with one responsibility each
- Flat structures over deep nesting
- If a function is hard to test, the design needs simplification

## Code Conventions

- Named exports only, no default exports
- `type` keyword for type-only imports
- Errors: always throw `BotError` with an error code (see `error-handling` skill)
- Async/await everywhere, no raw callbacks or .then() chains
- `const` by default, `let` only when reassignment is needed
- File naming: camelCase for files, PascalCase for classes/types/interfaces
- One class or major function per file (exceptions: small related utilities)
- All public module functions must have JSDoc with @param and @returns

## State Management

- All runtime state goes through `StateManager` (never raw fs read/write)
- Atomic writes: write to tmp file, then `fs.renameSync`
- All reads from in-memory object (never disk I/O on hot path)
- Every state mutation MUST call `save()` immediately after

## Resilience Rules

- MCP/cache fetch fails → degrade gracefully, never crash
- Session history replay fails → skip, post confirmation anyway
- Autocomplete cache miss → return empty results
- SSE disconnect → retry 3x, then notify user
- Never let a non-critical failure block core functionality

## Review Workflow

This project uses **two-stage review gates** after each implementation task:

### Stage 1: Spec Compliance Review

A reviewer checks the implementation against the PLAN.md specification:
- Every requirement in the spec has corresponding implementation
- No extra functionality was added beyond the spec
- Types/interfaces match what the spec describes
- Error codes and messages match the spec

**Must pass before Stage 2.** If gaps found → fix → re-review.

### Stage 2: Code Quality Review

A reviewer checks against project conventions:
- Named exports, type imports, BotError usage, async/await
- JSDoc on public functions
- Module boundary compliance (import direction DAG)
- State mutations call save() immediately
- Graceful degradation for non-critical paths
- Tests written first and cover the behavior

**Must pass before marking complete.** If issues found → fix → re-review.

### When to Review

- After each sub-agent completes a task (in `/implement`)
- After each round completes (integration review)
- Before merging any branch (final review via `/review`)
- Security audit before first deployment (via `/security-review`)

## Git Workflow

- Create a branch per implementation round: `round-N/description`
- Commit after every successful TDD cycle (RED→GREEN→REFACTOR = one commit)
- Commit messages: `feat:`, `fix:`, `test:`, `refactor:` prefixes
- Never commit failing tests (except the deliberate RED step which gets amended in GREEN)
- Squash-merge rounds into main when review passes

## Implementation Workflow

This project uses **subagent-driven-development** for parallel implementation. See IMPLEMENTATION.md for the full plan with checkbox steps.

**Execution:** Use the `/implement` command which dispatches sub-agents with two-stage review per task.

**Process per round:**
1. Extract all tasks for the round from IMPLEMENTATION.md
2. For each task: dispatch implementer → spec review → code quality review → mark complete
3. After all tasks: verify integration (`pnpm tsc --noEmit` + `pnpm test`)
4. Commit the round

**Sub-agent prompt requirements:**
- Include the full task text (never reference the plan file)
- Include TypeScript interfaces from prior rounds (inline)
- Include exact file paths owned by the sub-agent
- Instruct TDD methodology (test first)
- Instruct to load relevant skills for domain context

## Verification

After writing or modifying code, always run:
```
pnpm tsc --noEmit && pnpm test
```

Both must pass. Type errors are fixed immediately, not deferred.

## Skills Available

### Project-Specific Skills (load on-demand)

- `sdk-reference` — OpenCode SDK v2 calling conventions and types
- `discord-patterns` — discord.js v14 API patterns
- `error-handling` — BotError class, error codes, correlation IDs
- `module-boundaries` — File ownership, import direction, interface contracts
- `process-lifecycle` — Spawning/monitoring/shutting down opencode serve processes

### From superpowers Plugin (auto-available)

- `superpowers:test-driven-development` — TDD methodology (MANDATORY for all implementation)
- `superpowers:subagent-driven-development` — Task dispatch with two-stage review
- `superpowers:writing-plans` — Plan creation with checkbox format
- `superpowers:brainstorming` — Design refinement before implementation
- `superpowers:systematic-debugging` — 4-phase root cause analysis
- `superpowers:verification-before-completion` — Ensure fixes are actually fixed
- `superpowers:executing-plans` — Batch execution with human checkpoints

### From opencode-power-pack Plugin (auto-available)

- `code-review` — Multi-agent PR review with confidence-filtered cross-checks
- `security-review` — OWASP-bucketed audit with concrete PoC requirement
- `code-explorer` — Deep codebase analysis, trace features end-to-end
- `code-architect` — Architecture blueprint with file-level implementation map
- `code-reviewer` — Two-pass adversarial review with edge-case checklist
- `agents-md-improver` — Audit and update this AGENTS.md against current codebase

## Commands Available

- `/implement <round>` — Execute a round with subagent-driven-development + two-stage review
- `/verify` — Type-check and fix errors
- `/review [target]` — Multi-agent code review on changes or PR
- `/security-review [target]` — Security audit with project-specific attack surface focus
- `/plan [description]` — Create or update implementation plan

## MCP Available

- `context7` — Look up library documentation (discord.js, zod, chokidar, satori, etc.)
