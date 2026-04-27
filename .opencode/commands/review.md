---
description: Run multi-agent code review on recent changes or a PR
---

Load the `code-review` skill and execute it against the following target: $ARGUMENTS

**Default behavior (no arguments):** Review the diff of all uncommitted changes (staged + unstaged) using `git diff HEAD`.

**With arguments:** Review the specified target. Examples:
- A PR URL: `https://github.com/owner/repo/pull/123`
- A branch comparison: `main..feature-branch`
- A commit range: `abc1234..def5678`

**Project-specific review focus areas:**

1. **Module boundary violations** — imports must follow the DAG: `utils/ ← config/ ← state/ ← queue/ ← opencode/ ← discord/`
2. **State management** — all mutations through StateManager, atomic saves, no raw fs
3. **Error handling** — all errors use BotError with proper error codes and correlation IDs
4. **SDK usage** — always import from `@opencode-ai/sdk/v2`, never the root import
5. **Resilience** — non-critical failures must degrade gracefully, never crash
6. **Discord conventions** — defer replies for long ops, respect 2000 char limit, ephemeral errors

After completing the review, summarize findings grouped by severity (Critical / Important).
If no issues found, state: "No issues found. Checked for bugs, conventions, module boundaries, and error handling."
