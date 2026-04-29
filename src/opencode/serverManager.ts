import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createLogger } from '../utils/logger.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import type { ServerState } from '../state/types.js';

const logger = createLogger('ServerManager');
const require = createRequire(import.meta.url);
const launch = require('cross-spawn') as (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessLike;

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;
export type ServerManagerClient = OpencodeClient;
type HealthResult = Awaited<ReturnType<ServerManagerClient['global']['health']>>;

interface ChildProcessLike extends EventEmitter {
  pid?: number;
  killed?: boolean;
  stdout?: { resume(): void } | null;
  stderr?: { resume(): void } | null;
  kill(signal?: NodeJS.Signals): boolean;
}

class RecoveredProcess extends EventEmitter implements ChildProcessLike {
  public killed = false;

  public constructor(public readonly pid: number) {
    super();
  }

  public kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

interface StateManagerLike {
  getServer(projectPath: string): ServerState | undefined;
  setServer(projectPath: string, server: ServerState): void;
  removeServer(projectPath: string): void;
}

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

interface ManagedServer {
  client: OpencodeClient;
  exited: boolean;
  failures: number;
  process: ChildProcessLike;
  state: ServerState;
  healthMonitor?: Interval;
  idleTimer?: Timer;
  shutdownPromise?: Promise<void>;
  stopping?: boolean;
}

/** Constructor dependencies and timing controls for ServerManager. */
export interface ServerManagerOptions {
  stateManager: StateManagerLike;
  autoConnectProjects?: Set<string>;
  spawnProcess?: (projectPath: string, port: number) => ChildProcessLike;
  createClient?: (url: string) => OpencodeClient;
  allocatePort?: () => Promise<number>;
  healthCheck?: (client: OpencodeClient) => Promise<boolean>;
  now?: () => number;
  idleTimeoutMs?: number;
  healthIntervalMs?: number;
  shutdownTimeoutMs?: number;
  startupPollMs?: number;
  startupTimeoutMs?: number;
}

/**
 * Allocate an available loopback TCP port using the operating system.
 * @returns Free TCP port number
 */
export async function allocateFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate TCP port')));
        return;
      }

      server.close(() => resolve(address.port));
    });
  });
}

function spawnServer(projectPath: string, port: number): ChildProcessLike {
  return launch('opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: projectPath,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHealthy(result: HealthResult | unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }

  if (result.healthy === true) {
    return true;
  }

  return isRecord(result.data) && result.data.healthy === true;
}

async function defaultHealthCheck(client: OpencodeClient): Promise<boolean> {
  try {
    const result = await client.global.health();
    return isHealthy(result);
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Manages one opencode serve process per project path. */
export class ServerManager {
  private readonly stateManager: StateManagerLike;
  private readonly autoConnectProjects: Set<string>;
  private readonly spawnProcess: (projectPath: string, port: number) => ChildProcessLike;
  private readonly createClient: (url: string) => OpencodeClient;
  private readonly allocatePort: () => Promise<number>;
  private readonly healthCheck: (client: OpencodeClient) => Promise<boolean>;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly startupPollMs: number;
  private readonly startupTimeoutMs: number;
  private readonly servers = new Map<string, ManagedServer>();
  private readonly startups = new Map<string, Promise<OpencodeClient>>();

  /**
   * Create a manager for opencode serve processes.
   * @param options - Runtime dependencies and optional timing overrides
   */
  public constructor(options: ServerManagerOptions) {
    this.stateManager = options.stateManager;
    this.autoConnectProjects = options.autoConnectProjects ?? new Set();
    this.spawnProcess = options.spawnProcess ?? spawnServer;
    this.createClient = options.createClient ?? ((url) => createOpencodeClient({ baseUrl: url }));
    this.allocatePort = options.allocatePort ?? allocateFreePort;
    this.healthCheck = options.healthCheck ?? defaultHealthCheck;
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
    this.healthIntervalMs = options.healthIntervalMs ?? 60 * 1000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
    this.startupPollMs = options.startupPollMs ?? 500;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30 * 1000;
  }

  /**
   * Ensure an opencode server is running for a project path.
   * @param projectPath - Project path to serve
   * @returns OpenCode SDK client connected to the running server
   */
  public async ensureRunning(projectPath: string): Promise<OpencodeClient> {
    const existing = this.servers.get(projectPath);
    if (existing !== undefined) {
      if (existing.shutdownPromise !== undefined || existing.stopping === true) {
        await this.shutdown(projectPath);
        return await this.ensureRunning(projectPath);
      }

      this.cancelIdleTimer(existing);
      return existing.client;
    }

    const startup = this.startups.get(projectPath);
    if (startup !== undefined) {
      return await startup;
    }

    const nextStartup = this.startServer(projectPath);
    this.startups.set(projectPath, nextStartup);

    try {
      return await nextStartup;
    } finally {
      if (this.startups.get(projectPath) === nextStartup) {
        this.startups.delete(projectPath);
      }
    }
  }

  private async startServer(projectPath: string): Promise<OpencodeClient> {
    const port = await this.allocatePort();
    const url = `http://127.0.0.1:${port}`;
    const serverProcess = this.spawnProcess(projectPath, port);
    drainProcessOutput(serverProcess);
    const client = this.createClient(url);
    let managed: ManagedServer | undefined;
    let startupSettled = false;
    let processExited = false;
    const startupProcessFailure = new Promise<never>((_, reject) => {
      serverProcess.once('error', (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      serverProcess.once('exit', (code, signal) => {
        processExited = true;
        if (managed !== undefined && this.servers.get(projectPath) === managed) {
          managed.exited = true;
          void this.handleManagedExit(projectPath, managed);
          return;
        }

        if (!startupSettled) {
          reject(new Error(`OpenCode server exited during startup: code=${String(code)} signal=${String(signal)}`));
        }
      });
    });

    try {
      await Promise.race([this.waitForHealthy(client), startupProcessFailure]);
    } catch (error) {
      startupSettled = true;
      if (!processExited) {
        serverProcess.kill('SIGTERM');
      }
      throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode server failed to become healthy', {
        projectPath,
        url,
        error,
      });
    }
    startupSettled = true;

    const state: ServerState = {
      port,
      pid: serverProcess.pid ?? 0,
      url,
      startedAt: this.now(),
      status: 'running',
    };
    managed = {
      client,
      exited: processExited,
      failures: 0,
      process: serverProcess,
      state,
    };

    this.servers.set(projectPath, managed);
    this.stateManager.setServer(projectPath, state);
    this.startHealthMonitor(projectPath, managed);

    return client;
  }

  /**
   * Get the running client for a project path, if present.
   * @param projectPath - Project path used as the server key
   * @returns OpenCode SDK client or undefined when no server is running
   */
  public getClient(projectPath: string): OpencodeClient | undefined {
    return this.servers.get(projectPath)?.client;
  }

  /**
   * Register an already-running OpenCode server recovered during bot startup.
   * @param projectPath - Project path used as the server key
   * @param client - SDK client connected to the recovered server
   * @param state - Persisted running server state
   * @returns Nothing
   */
  public registerRecovered(projectPath: string, client: OpencodeClient, state: ServerState): void {
    const existing = this.servers.get(projectPath);
    if (existing !== undefined) {
      return;
    }

    const managed: ManagedServer = {
      client,
      exited: false,
      failures: 0,
      process: new RecoveredProcess(state.pid),
      state,
    };
    this.servers.set(projectPath, managed);
    this.stateManager.setServer(projectPath, state);
    this.startHealthMonitor(projectPath, managed);
  }

  /**
   * Schedule an idle shutdown for a running project server.
   * @param projectPath - Project path used as the server key
   * @returns Nothing
   */
  public scheduleIdleShutdown(projectPath: string): void {
    if (this.autoConnectProjects.has(projectPath)) {
      return;
    }

    const managed = this.servers.get(projectPath);
    if (managed === undefined) {
      return;
    }

    this.cancelIdleTimer(managed);
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = undefined;
      void this.shutdown(projectPath);
    }, this.idleTimeoutMs);
  }

  /**
   * Shut down the server for a project path.
   * @param projectPath - Project path used as the server key
   * @returns Nothing
   */
  public async shutdown(projectPath: string): Promise<void> {
    const managed = this.servers.get(projectPath);
    if (managed === undefined) {
      return;
    }

    if (managed.shutdownPromise !== undefined) {
      return await managed.shutdownPromise;
    }

    managed.shutdownPromise = this.performShutdown(projectPath, managed);
    return await managed.shutdownPromise;
  }

  private async performShutdown(projectPath: string, managed: ManagedServer): Promise<void> {
    managed.stopping = true;
    this.cancelIdleTimer(managed);
    this.stopHealthMonitor(managed);

    if (!managed.exited) {
      managed.process.kill('SIGTERM');
      await this.waitForExitOrTimeout(managed);
      if (!managed.exited) {
        managed.process.kill('SIGKILL');
      }
    }

    this.markStopped(projectPath, managed);
  }

  /**
   * Shut down every running server managed by this instance.
   * @returns Nothing
   */
  public async shutdownAll(): Promise<void> {
    const projectPaths = [...this.servers.keys()];
    for (const projectPath of projectPaths) {
      await this.shutdown(projectPath);
    }
  }

  private async waitForHealthy(client: OpencodeClient): Promise<void> {
    const deadline = this.now() + this.startupTimeoutMs;
    while (this.now() <= deadline) {
      if (await this.healthCheck(client)) {
        return;
      }

      await delay(this.startupPollMs);
    }

    throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server health check timed out');
  }

  private startHealthMonitor(projectPath: string, managed: ManagedServer): void {
    managed.healthMonitor = setInterval(() => {
      void this.checkHealth(projectPath, managed);
    }, this.healthIntervalMs);
  }

  private async checkHealth(projectPath: string, managed: ManagedServer): Promise<void> {
    if (this.servers.get(projectPath) !== managed) {
      return;
    }

    const healthy = await this.healthCheck(managed.client);
    if (healthy) {
      managed.failures = 0;
      return;
    }

    managed.failures += 1;
    if (managed.failures >= 3) {
      logger.warn('Server failed periodic health checks', {
        code: ErrorCode.SERVER_UNHEALTHY,
        projectPath,
        consecutiveFailures: managed.failures,
      });
      void this.shutdown(projectPath);
    }
  }

  private async handleManagedExit(projectPath: string, managed: ManagedServer): Promise<void> {
    managed.exited = true;
    if (managed.stopping === true) {
      return;
    }

    this.markStopped(projectPath, managed);
  }

  private async waitForExitOrTimeout(managed: ManagedServer): Promise<void> {
    if (managed.exited) {
      return;
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        managed.process.once('exit', () => {
          managed.exited = true;
          resolve();
        });
      }),
      delay(this.shutdownTimeoutMs),
    ]);
  }

  private markStopped(projectPath: string, managed: ManagedServer): void {
    if (this.servers.get(projectPath) !== managed) {
      return;
    }

    this.cancelIdleTimer(managed);
    this.stopHealthMonitor(managed);

    this.servers.delete(projectPath);
    this.stateManager.setServer(projectPath, {
      ...managed.state,
      status: 'stopped',
    });
  }

  private stopHealthMonitor(managed: ManagedServer): void {
    if (managed.healthMonitor !== undefined) {
      clearInterval(managed.healthMonitor);
      managed.healthMonitor = undefined;
    }
  }

  private cancelIdleTimer(managed: ManagedServer): void {
    if (managed.idleTimer !== undefined) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = undefined;
    }
  }
}

function drainProcessOutput(process: ChildProcessLike): void {
  process.stdout?.resume();
  process.stderr?.resume();
}
