import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { allocateFreePort, ServerManager } from './serverManager.js';
import type { ServerState } from '../state/types.js';
import type { ServerManagerClient } from './serverManager.js';

class MockProcess extends EventEmitter {
  public killed = false;

  public constructor(public readonly pid: number) {
    super();
  }

  public kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

interface MockStateManager {
  getServer: ReturnType<typeof vi.fn<(projectPath: string) => ServerState | undefined>>;
  setServer: ReturnType<typeof vi.fn<(projectPath: string, server: ServerState) => void>>;
  removeServer: ReturnType<typeof vi.fn<(projectPath: string) => void>>;
}

type TestClient = ServerManagerClient & { id: string };

function createStateManager(): MockStateManager {
  return {
    getServer: vi.fn(),
    setServer: vi.fn(),
    removeServer: vi.fn(),
  };
}

function createClient(id: string): TestClient {
  return {
    id,
    global: {
      health: vi.fn(async () => ({ healthy: true })),
    },
  } as unknown as TestClient;
}

describe('allocateFreePort', () => {
  it('allocates a free localhost port with net.createServer', async () => {
    const port = await allocateFreePort();

    expect(port).toBeGreaterThan(0);
  });
});

describe('ServerManager', () => {
  const projectPath = '/tmp/project';
  let stateManager: MockStateManager;
  let process: MockProcess;
  let client: ReturnType<typeof createClient>;

  beforeEach(() => {
    stateManager = createStateManager();
    process = new MockProcess(1234);
    client = createClient('client-1');
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns opencode serve when ensureRunning is called for a stopped project', async () => {
    const spawnProcess = vi.fn(() => process);
    const manager = new ServerManager({
      stateManager,
      spawnProcess,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
    });

    const result = await manager.ensureRunning(projectPath);

    expect(result).toBe(client);
    expect(spawnProcess).toHaveBeenCalledWith(projectPath, 4321);
    expect(stateManager.setServer).toHaveBeenCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'running',
    });
  });

  it('returns the existing client without spawning when already running', async () => {
    const spawnProcess = vi.fn(() => process);
    const manager = new ServerManager({
      stateManager,
      spawnProcess,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
    });

    await manager.ensureRunning(projectPath);
    const result = await manager.ensureRunning(projectPath);

    expect(result).toBe(client);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('polls health until the server becomes healthy', async () => {
    const healthCheck = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck,
      startupPollMs: 1,
    });

    await manager.ensureRunning(projectPath);

    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  it('removes the client and marks the server stopped when the process exits', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
    });
    await manager.ensureRunning(projectPath);

    process.emit('exit', 1, null);

    expect(manager.getClient(projectPath)).toBeUndefined();
    expect(stateManager.setServer).toHaveBeenLastCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'stopped',
    });
  });

  it('shuts down an idle server after the idle timeout', async () => {
    vi.useFakeTimers();
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      idleTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    manager.scheduleIdleShutdown(projectPath);
    await vi.advanceTimersByTimeAsync(50);

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not schedule idle shutdown for auto-connect projects', async () => {
    vi.useFakeTimers();
    const manager = new ServerManager({
      stateManager,
      autoConnectProjects: new Set([projectPath]),
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      idleTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    manager.scheduleIdleShutdown(projectPath);
    await vi.advanceTimersByTimeAsync(100);

    expect(process.kill).not.toHaveBeenCalled();
  });

  it('kills and marks a server stopped during graceful shutdown', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
    });
    await manager.ensureRunning(projectPath);

    await manager.shutdown(projectPath);

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(manager.getClient(projectPath)).toBeUndefined();
    expect(stateManager.setServer).toHaveBeenLastCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'stopped',
    });
  });

  it('shuts down all tracked servers', async () => {
    const processTwo = new MockProcess(5678);
    const clients = [createClient('client-1'), createClient('client-2')];
    const processes = [process, processTwo];
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => processes.shift()!,
      allocatePort: vi.fn()
        .mockResolvedValueOnce(4321)
        .mockResolvedValueOnce(4322),
      createClient: () => clients.shift()!,
      healthCheck: async () => true,
    });
    await manager.ensureRunning('/tmp/project-one');
    await manager.ensureRunning('/tmp/project-two');

    await manager.shutdownAll();

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(processTwo.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('treats three consecutive periodic health failures as a crash', async () => {
    vi.useFakeTimers();
    const healthCheck = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck,
      healthIntervalMs: 10,
      now: () => 1000,
    });
    await manager.ensureRunning(projectPath);

    await vi.advanceTimersByTimeAsync(30);

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(manager.getClient(projectPath)).toBeUndefined();
    expect(stateManager.setServer).toHaveBeenLastCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'stopped',
    });
  });
});
