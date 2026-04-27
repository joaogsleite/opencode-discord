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
  kill(signal?: NodeJS.Signals): boolean;
}

interface StateManagerLike {
  getServer(projectPath: string): ServerState | undefined;
  setServer(projectPath: string, server: ServerState): void;
  removeServer(projectPath: string): void;
}

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

interface ManagedServer {
  client: OpencodeClient;
  failures: number;
  process: ChildProcessLike;
  state: ServerState;
  healthMonitor?: Interval;
  idleTimer?: Timer;
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

function isHealthy(result: HealthResult): boolean {
  return 'data' in result && result.data?.healthy === true;
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
  private readonly startupPollMs: number;
  private readonly startupTimeoutMs: number;
  private readonly servers = new Map<string, ManagedServer>();

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
      this.cancelIdleTimer(existing);
      return existing.client;
    }

    const port = await this.allocatePort();
    const url = `http://127.0.0.1:${port}`;
    const serverProcess = this.spawnProcess(projectPath, port);
    const client = this.createClient(url);

    try {
      await this.waitForHealthy(client);
    } catch (error) {
      serverProcess.kill('SIGTERM');
      throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode server failed to become healthy', {
        projectPath,
        url,
        error,
      });
    }

    const state: ServerState = {
      port,
      pid: serverProcess.pid ?? 0,
      url,
      startedAt: this.now(),
      status: 'running',
    };
    const managed: ManagedServer = {
      client,
      failures: 0,
      process: serverProcess,
      state,
    };

    this.servers.set(projectPath, managed);
    this.stateManager.setServer(projectPath, state);
    serverProcess.once('exit', () => {
      if (this.servers.get(projectPath) === managed) {
        this.markStopped(projectPath, managed, false);
      }
    });
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

    this.markStopped(projectPath, managed, true);
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
      this.markStopped(projectPath, managed, true);
    }
  }

  private markStopped(projectPath: string, managed: ManagedServer, killProcess: boolean): void {
    this.cancelIdleTimer(managed);
    if (managed.healthMonitor !== undefined) {
      clearInterval(managed.healthMonitor);
      managed.healthMonitor = undefined;
    }

    if (killProcess && managed.process.killed !== true) {
      managed.process.kill('SIGTERM');
    }

    this.servers.delete(projectPath);
    this.stateManager.setServer(projectPath, {
      ...managed.state,
      status: 'stopped',
    });
  }

  private cancelIdleTimer(managed: ManagedServer): void {
    if (managed.idleTimer !== undefined) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = undefined;
    }
  }
}
