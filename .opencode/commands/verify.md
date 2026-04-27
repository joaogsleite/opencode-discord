---
description: Type-check the project and fix any errors
agent: build
---

Run verification:
1. Execute `pnpm tsc --noEmit`
2. If there are type errors, analyze and fix them
3. Re-run until clean compilation
4. Report: number of source files, any issues fixed
