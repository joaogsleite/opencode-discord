---
description: Create or update implementation plan using writing-plans methodology
---

Load the `writing-plans` skill and use it for the following: $ARGUMENTS

**Context:**
- This is the opencode-discord project — a Discord bot mapping channels to OpenCode agents
- The design spec lives in `PLAN.md` (read it for full behavioral specification)
- Implementation plan lives in `IMPLEMENTATION.md`
- The project uses vitest for testing and pnpm as package manager

**Constraints:**
- Every task MUST include TDD steps (write failing test → verify fail → implement → verify pass → commit)
- Use checkbox (`- [ ]`) syntax for step tracking
- Include exact file paths, exact code blocks, exact shell commands
- No placeholders — every step must contain the actual content needed
- Tasks should be 2-5 minutes each (bite-sized)
- Maintain the parallel sub-agent execution model (tasks that can run independently are grouped into rounds)

**Plan location:** Save to `IMPLEMENTATION.md` (overwrite existing if updating).

**After writing the plan:** Run the spec self-review checklist:
1. Check every PLAN.md requirement has a corresponding task
2. Scan for placeholders (TBD, TODO, "implement X")
3. Verify type/interface consistency across tasks
4. Confirm test commands reference correct file paths
