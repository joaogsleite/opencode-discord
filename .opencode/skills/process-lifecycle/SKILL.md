---
name: process-lifecycle
description: Patterns for spawning, monitoring, health-checking, and gracefully shutting down opencode serve child processes with cross-spawn and PID tracking
---

## Spawning a Server

```ts
import launch from "cross-spawn"
import net from "net"

/** Allocate a free port via the OS */
async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

/** Spawn opencode serve for a project */
function spawnServer(projectPath: string, port: number): ChildProcess {
  const proc = launch("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
    cwd: projectPath,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({}) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return proc
}
```

## Startup Detection

Parse stdout for the ready message:

```ts
proc.stdout.on("data", (chunk: Buffer) => {
  const line = chunk.toString()
  // Look for: "opencode server listening on http://127.0.0.1:<port>"
  const match = line.match(/listening on (http:\/\/[\d.:]+)/)
  if (match) {
    const url = match[1]
    // Server is ready -- create client
    const client = createOpencodeClient({ baseUrl: url })
  }
})
```

Timeout after 30 seconds if no ready message → kill process, throw SERVER_START_FAILED.

## Health Check

```ts
async function healthCheck(client: OpencodeClient): Promise<boolean> {
  try {
    const result = await client.global.health()
    return result.healthy === true
  } catch {
    return false
  }
}
```

### Startup health check
- After detecting ready message, poll every 500ms until `healthCheck()` returns true
- Timeout: 30 seconds → kill, throw SERVER_START_FAILED

### Periodic monitoring
- While server is running: check every 60 seconds
- Track consecutive failures (increment on fail, reset on success)
- 3 consecutive failures → treat as crashed

## Crash Detection

```ts
proc.on("exit", (code, signal) => {
  // Server exited unexpectedly
  markServerStopped(projectPath)
  notifyAllThreads(projectPath, "OpenCode server crashed. Will restart on next interaction.")

  // For autoConnect projects: restart immediately
  if (hasAutoConnect(projectPath)) {
    restartServer(projectPath)
  }
})
```

Also handle the "zombie" case via periodic health checks (process alive but unresponsive).

## Idle Timer

```ts
class IdleTimerManager {
  private timers = new Map<string, NodeJS.Timeout>()

  /** Start idle countdown. Suppressed for autoConnect projects. */
  start(projectPath: string, durationMs: number, onExpire: () => void): void {
    if (this.isAutoConnect(projectPath)) return // never idle-shutdown autoConnect
    this.cancel(projectPath)
    this.timers.set(projectPath, setTimeout(() => {
      this.timers.delete(projectPath)
      onExpire()
    }, durationMs))
  }

  cancel(projectPath: string): void {
    const timer = this.timers.get(projectPath)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(projectPath)
    }
  }
}
```

Default idle duration: 5 minutes after last active session ends.

## Graceful Shutdown

On SIGINT/SIGTERM, shut down all servers cleanly:

```ts
async function shutdownAll(servers: Map<string, ManagedServer>): Promise<void> {
  const shutdowns = [...servers.entries()].map(async ([path, server]) => {
    // 1. Abort all active sessions
    for (const session of getActiveSessions(path)) {
      try { await server.client.session.abort({ sessionID: session.sessionId }) } catch {}
    }
    // 2. Kill the process
    server.process.kill("SIGTERM")
    // 3. Wait up to 5s for exit
    await Promise.race([
      new Promise<void>(resolve => server.process.on("exit", resolve)),
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ])
    // 4. Force kill if still alive
    if (!server.process.killed) server.process.kill("SIGKILL")
    // 5. Update state
    markServerStopped(path)
  })
  await Promise.allSettled(shutdowns)
}
```

## State Persistence

Always persist server state to state.json:

```ts
interface ServerState {
  port: number
  pid: number
  url: string
  startedAt: number
  status: "running" | "stopped"
}
```

- On start: save immediately with status "running"
- On stop/crash: save immediately with status "stopped"
- On bot restart: read state, check if PID alive (`process.kill(pid, 0)`), reconnect or mark stopped

## Reconnection on Bot Restart

```ts
async function recoverServer(projectPath: string, saved: ServerState): Promise<void> {
  // Check if process is still alive
  try {
    process.kill(saved.pid, 0) // signal 0 = just check existence
  } catch {
    markServerStopped(projectPath)
    return
  }

  // Process alive -- try to connect
  const client = createOpencodeClient({ baseUrl: saved.url })
  if (await healthCheck(client)) {
    // Healthy -- reconnect
    registerRunningServer(projectPath, client, saved)
  } else {
    // Unhealthy zombie -- kill it
    process.kill(saved.pid, "SIGKILL")
    markServerStopped(projectPath)
  }
}
```
