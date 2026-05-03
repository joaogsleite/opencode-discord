import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

const repoRoot = join(import.meta.dirname, "..")

describe("macOS service scripts", () => {
  test("LaunchAgent runs the service wrapper instead of pnpm directly", () => {
    const setupScript = readFileSync(join(repoRoot, "scripts/service/setup.sh"), "utf8")

    expect(setupScript).toContain("${RUN_SCRIPT}")
    expect(setupScript).not.toContain("<string>pnpm</string>")
    expect(setupScript).not.toContain("<string>dev</string>")
  })

  test("service wrapper selects nvm node and runs local tsx without package managers", () => {
    const runScript = readFileSync(join(repoRoot, "scripts/service/run.sh"), "utf8")

    expect(runScript).toContain("source \"${NVM_SCRIPT}\"")
    expect(runScript).toContain("nvm use")
    expect(runScript).toContain("./node_modules/.bin/tsx")
    expect(runScript).toContain("exec ./node_modules/.bin/tsx src/index.ts")
    expect(runScript).not.toMatch(/^\s*(exec\s+)?(pnpm|npm|corepack)\b/m)
    expect(runScript).not.toContain("nvm install")
  })
})
