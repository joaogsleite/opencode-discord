---
description: Security audit focusing on token handling, fs access, and process spawning
---

Load the `security-review` skill and execute it against this project.

**Target:** $ARGUMENTS

If no arguments provided, audit all source files under `src/`.

**Project-specific attack surface — pay special attention to:**

1. **Discord token handling**
   - Token must never appear in logs, error messages, or state.json
   - Verify token is only read from config.yaml (never hardcoded)
   - Check that config hot-reload doesn't leak token during transition

2. **File system path traversal**
   - `/ls`, `/cat`, `/download` commands accept user-provided paths
   - Verify `projectPath` sandboxing — no `../` escape above project root
   - Check `filesystem.ts` safe path resolution against symlink attacks

3. **Child process injection**
   - `cross-spawn` receives `cwd` from config — verify no user-controlled injection
   - `/git` commands pass user arguments to git — verify argument sanitization
   - Check that `OPENCODE_CONFIG_CONTENT` env var can't be manipulated

4. **SSE / Network**
   - SSE reconnection must not leak auth tokens in URLs
   - Verify SDK client credentials aren't logged on connection failure
   - Check that `baseUrl` construction doesn't allow SSRF

5. **Permission model**
   - Verify `allowedUsers` check happens before any command execution
   - Check that `allowedAgents` can't be bypassed via `/agent set`
   - Verify `permissions: auto` vs `interactive` is enforced correctly

6. **State file security**
   - `state.json` must not contain sensitive data (tokens, credentials)
   - Verify atomic writes can't race with reads to produce corrupt state
   - Check file permissions on state.json (should not be world-readable)

**Output format:** For each finding, include:
- Severity (Critical / High / Medium / Low)
- Concrete attack scenario (how would this be exploited?)
- Affected file and line
- Suggested fix
