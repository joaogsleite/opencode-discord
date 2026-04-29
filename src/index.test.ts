import { describe, expect, it, vi } from 'vitest';
import { startBot } from './index.js';
import type { BotState, ServerState, SessionState } from './state/types.js';

describe('startBot', () => {
  it('watches config reloads, cleans up removed channel sessions, redeploys commands, and closes the watcher', async () => {
    let reloadConfig = {
      discordToken: 'token',
      servers: [{ serverId: 'guild-2', channels: [{ channelId: 'channel-new', projectPath: '/project/new' }] }],
    };
    const removedSession: SessionState = {
      sessionId: 'session-removed',
      guildId: 'guild-1',
      channelId: 'channel-removed',
      projectPath: '/project/removed',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const otherSession: SessionState = {
      ...removedSession,
      sessionId: 'session-kept',
      channelId: 'channel-kept',
    };
    const endedSession: SessionState = {
      ...removedSession,
      sessionId: 'session-ended',
      status: 'ended',
    };
    const state: BotState = {
      version: 1,
      servers: {},
      sessions: {
        'thread-removed': removedSession,
        'thread-kept': otherSession,
        'thread-ended': endedSession,
      },
      queues: {
        'thread-removed': [{ userId: 'user-1', content: 'remove me', attachments: [], queuedAt: 30 }],
        'thread-kept': [{ userId: 'user-2', content: 'keep me', attachments: [], queuedAt: 40 }],
      },
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn((threadId: string) => {
        state.queues[threadId] = [];
      }),
    };
    const opencodeClient = { session: { abort: vi.fn() } };
    const thread = { send: vi.fn(), setArchived: vi.fn() };
    const lifecycleController = {
      runInactivityCheck: vi.fn(),
      shutdown: vi.fn(),
      dispose: vi.fn(),
    };
    const registerLifecycleHandlers = vi.fn<typeof startBot extends (options: infer Options) => Promise<unknown>
      ? NonNullable<Options extends { registerLifecycleHandlers?: infer Register } ? Register : never>
      : never>(() => lifecycleController);
    const watch = vi.fn();
    const close = vi.fn();
    const onChange = vi.fn((callback: (config: typeof reloadConfig) => void) => {
      callback(reloadConfig);
    });
    const deployCommands = vi.fn();

    const started = await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-removed', projectPath: '/project/removed' }] }],
        })),
        watch,
        close,
        onChange,
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => opencodeClient),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({
        login: vi.fn(),
        channels: { fetch: vi.fn(async () => thread) },
      })),
      deployCommands,
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      registerLifecycleHandlers,
    });

    expect(watch).toHaveBeenCalledOnce();
    const watchOptions = watch.mock.calls[0]?.[0] as { onChannelRemoved?: (guildId: string, channelId: string) => Promise<void> | void } | undefined;
    expect(watchOptions?.onChannelRemoved).toBeTypeOf('function');
    await watchOptions?.onChannelRemoved?.('guild-1', 'channel-removed');

    expect(opencodeClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-removed' });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-removed', { ...removedSession, status: 'ended' });
    expect(stateManager.clearQueue).toHaveBeenCalledWith('thread-removed');
    expect(thread.send).toHaveBeenCalledWith('Channel removed from config. Session ended.');
    expect(thread.setArchived).toHaveBeenCalledWith(true);
    expect(state.sessions['thread-kept']?.status).toBe('active');
    expect(opencodeClient.session.abort).not.toHaveBeenCalledWith({ sessionID: 'session-ended' });

    expect(onChange).toHaveBeenCalledOnce();
    expect(deployCommands).toHaveBeenCalledWith('token', 'guild-2', []);

    reloadConfig = { discordToken: 'token', servers: [] };
    await started.lifecycleController.shutdown();
    await started.lifecycleController.dispose();

    expect(close).toHaveBeenCalledTimes(2);
    expect(lifecycleController.shutdown).toHaveBeenCalledOnce();
    expect(lifecycleController.dispose).toHaveBeenCalledOnce();
  });

  it('registers lifecycle handlers with startup dependencies and exposes the controller', async () => {
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/one',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: {},
      sessions: { 'thread-1': session },
      queues: {},
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const opencodeClient = {
      session: {
        abort: vi.fn(),
      },
    };
    const serverManager = {
      ensureRunning: vi.fn(),
      getClient: vi.fn(() => opencodeClient),
      shutdownAll: vi.fn(),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const lifecycleController = {
      runInactivityCheck: vi.fn(),
      shutdown: vi.fn(),
      dispose: vi.fn(),
    };
    const registerLifecycleHandlers = vi.fn<typeof startBot extends (options: infer Options) => Promise<unknown>
      ? NonNullable<Options extends { registerLifecycleHandlers?: infer Register } ? Register : never>
      : never>(() => lifecycleController);
    const processLike = { on: vi.fn(), off: vi.fn() };
    const setInterval = vi.fn(() => 123);
    const clearInterval = vi.fn();

    const started = await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager,
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      registerLifecycleHandlers,
      processLike,
      setInterval,
      clearInterval,
    });

    expect(registerLifecycleHandlers).toHaveBeenCalledOnce();
    expect(registerLifecycleHandlers).toHaveBeenCalledWith(discordClient, expect.objectContaining({
      stateManager,
      serverManager,
      processLike,
      setInterval,
      clearInterval,
    }));
    expect(started.lifecycleController).toBe(lifecycleController);

    const lifecycleOptions = registerLifecycleHandlers.mock.calls[0]?.[1];
    expect(lifecycleOptions).toBeDefined();
    if (lifecycleOptions === undefined) {
      throw new Error('lifecycle options were not captured');
    }
    await lifecycleOptions.abortSession('thread-1', session);

    expect(serverManager.getClient).toHaveBeenCalledWith('/project/one');
    expect(opencodeClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-1' });
  });

  it('registers Discord interaction and message handlers during startup', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn(),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    expect(discordClient.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
    expect(discordClient.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    expect(discordClient.on).toHaveBeenCalledWith('threadDelete', expect.any(Function));

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => void) | undefined;
    const reply = vi.fn();
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: null,
      guildId: 'guild-1',
      commandName: 'help',
      user: { id: 'user-1' },
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      reply,
      followUp: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('wires real question and permission handlers into the default stream handler', async () => {
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/one',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 1,
      lastActivityAt: 1,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: {
        '/project/one': {
          port: 1234,
          pid: 4321,
          url: 'http://127.0.0.1:1234',
          startedAt: 1,
          status: 'running',
        },
      },
      sessions: { 'thread-1': session },
      queues: {},
    };
    const captured = { questionHandler: undefined as unknown, permissionHandler: undefined as unknown };
    const thread = {
      send: vi.fn(async () => ({
        createMessageComponentCollector: vi.fn(() => ({ on: vi.fn() })),
      })),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn(async () => thread) },
      on: vi.fn(),
      off: vi.fn(),
      destroy: vi.fn(),
    };
    const streamHandler = {
      subscribe: vi.fn(),
    };
    const createStreamHandler = vi.fn((options: { questionHandler?: unknown; permissionHandler?: unknown }) => {
      captured.questionHandler = options.questionHandler;
      captured.permissionHandler = options.permissionHandler;
      return streamHandler;
    });
    const questionClient = { question: { reply: vi.fn(), reject: vi.fn() } };
    const permissionClient = { permission: { reply: vi.fn() } };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn((threadId: string) => state.sessions[threadId]),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      createStreamHandler,
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => ({ id: 'recovered-client' })),
      healthCheck: vi.fn(() => true),
    });

    expect(captured.questionHandler).toBeDefined();
    await (captured.questionHandler as { handleQuestionEvent(threadId: string, event: unknown, client: unknown): Promise<void> }).handleQuestionEvent(
      'thread-1',
      { request: { id: 'question-1', sessionID: 'session-1', questions: [{ header: 'Choose', question: 'Proceed?', options: [{ label: 'Yes', description: 'Continue' }] }] } },
      questionClient,
    );
    expect(questionClient.question.reject).toHaveBeenCalledWith({ requestID: 'question-1' });

    expect(captured.permissionHandler).toBeDefined();
    await (captured.permissionHandler as { handlePermissionEvent(threadId: string, event: unknown, client: unknown): Promise<void> }).handlePermissionEvent(
      'thread-1',
      { request: { id: 'permission-1', sessionID: 'session-1', permission: 'write', patterns: ['src/**'] } },
      permissionClient,
    );
    expect(permissionClient.permission.reply).toHaveBeenCalledWith({ requestID: 'permission-1', reply: 'always' });
  });

  it('shuts down recovered servers and aborts recovered sessions not known to ServerManager', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 9876,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-recovered',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 20,
      lastActivityAt: 30,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-recovered': session },
      queues: {},
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
        state.servers[projectPath] = nextServer;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const recoveredClient = {
      session: {
        abort: vi.fn(),
      },
    };
    const serverManager = {
      ensureRunning: vi.fn(),
      getClient: vi.fn(() => undefined),
      shutdownAll: vi.fn(),
    };
    const killPid = vi.fn();

    const started = await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager,
      serverManager,
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({
        login: vi.fn(),
        channels: { fetch: vi.fn(async () => ({ send: vi.fn() })) },
        destroy: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
      killPid,
    });

    await started.lifecycleController.shutdown();

    expect(serverManager.getClient).toHaveBeenCalledWith('/project/recovered');
    expect(recoveredClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-recovered' });
    expect(serverManager.shutdownAll).toHaveBeenCalledOnce();
    expect(killPid).toHaveBeenCalledWith(9876);
    expect(stateManager.setServer).toHaveBeenCalledWith('/project/recovered', { ...server, status: 'stopped' });
  });

  it('loads state and config, recovers runtime state, starts eager servers, connects Discord, and syncs commands', async () => {
    const calls: string[] = [];
    const healthyServer: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const deadServer: ServerState = {
      port: 2345,
      pid: 222,
      url: 'http://127.0.0.1:2345',
      startedAt: 20,
      status: 'running',
    };
    const activeSession: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/healthy',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const endedSession: SessionState = {
      ...activeSession,
      sessionId: 'session-ended',
      projectPath: '/project/dead',
      status: 'ended',
    };
    const state: BotState = {
      version: 1,
      servers: {
        '/project/healthy': healthyServer,
        '/project/dead': deadServer,
      },
      sessions: {
        'thread-1': activeSession,
        'thread-ended': endedSession,
      },
      queues: {
        'thread-1': [{ userId: 'user-1', content: 'kept', attachments: [], queuedAt: 50 }],
        'thread-ended': [{ userId: 'user-2', content: 'discarded', attachments: [], queuedAt: 60 }],
      },
    };
    const config = {
      discordToken: 'token',
      servers: [
        {
          serverId: 'guild-1',
          channels: [
            { channelId: 'channel-1', projectPath: '/project/healthy' },
            { channelId: 'channel-2', projectPath: '/project/eager', autoConnect: true },
          ],
        },
      ],
    };
    const clients = {
      healthy: { id: 'healthy-client' },
      eager: { id: 'eager-client' },
    };

    const stateManager = {
      load: vi.fn(() => calls.push('state.load')),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, server: ServerState) => {
        calls.push(`state.setServer:${projectPath}:${server.status}`);
        state.servers[projectPath] = server;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        calls.push(`state.setSession:${threadId}:${session.status}`);
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn((threadId: string) => {
        calls.push(`state.clearQueue:${threadId}`);
        state.queues[threadId] = [];
      }),
    };
    const configLoader = {
      load: vi.fn(async () => {
        calls.push('config.load');
      }),
      getConfig: vi.fn(() => config),
    };
    const serverManager = {
      ensureRunning: vi.fn(async (projectPath: string) => {
        calls.push(`server.ensureRunning:${projectPath}`);
        return projectPath === '/project/eager' ? clients.eager : clients.healthy;
      }),
      getClient: vi.fn((projectPath: string) => (projectPath === '/project/healthy' ? clients.healthy : undefined)),
    };
    const cacheManager = {
      refresh: vi.fn(async (projectPath: string) => {
        calls.push(`cache.refresh:${projectPath}`);
      }),
    };
    const streamHandler = {
      subscribe: vi.fn(async (threadId: string, sessionId: string, client: unknown, dedupe?: Set<string>, projectPath?: string) => {
        void client;
        void dedupe;
        calls.push(`stream.subscribe:${threadId}:${sessionId}:${projectPath}`);
      }),
    };
    const discordClient = {
      login: vi.fn(async (token: string) => calls.push(`discord.login:${token}`)),
    };

    await startBot({
      configLoader,
      stateManager,
      serverManager,
      cacheManager,
      streamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(async (token, guildId) => {
        calls.push(`deploy:${token}:${guildId}`);
      }),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(async () => {
        calls.push('preflight');
      }),
      isPidAlive: vi.fn((pid) => pid === 111),
      createClient: vi.fn((url) => {
        calls.push(`client.create:${url}`);
        return clients.healthy;
      }),
      healthCheck: vi.fn(async (client) => client === clients.healthy),
      threadExists: vi.fn(() => true),
      notifyThread: vi.fn(async (threadId, message) => {
        calls.push(`notify:${threadId}:${message}`);
      }),
      subscribeProjectEvents: vi.fn(async (projectPath, client) => {
        void client;
        calls.push(`project.subscribe:${projectPath}`);
      }),
    });

    expect(calls).toEqual([
      'preflight',
      'state.load',
      'config.load',
      'client.create:http://127.0.0.1:1234',
      'cache.refresh:/project/healthy',
      'state.setServer:/project/dead:stopped',
      'discord.login:token',
      'stream.subscribe:thread-1:session-1:/project/healthy',
      'notify:thread-1:Bot restarted. Session reconnected.',
      'state.clearQueue:thread-ended',
      'server.ensureRunning:/project/eager',
      'cache.refresh:/project/eager',
      'project.subscribe:/project/eager',
      'deploy:token:guild-1',
    ]);
    expect(state.queues['thread-1']).toHaveLength(1);
    expect(state.queues['thread-ended']).toHaveLength(0);
  });

  it('marks a recovered session ended when its Discord thread no longer exists', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-deleted-thread',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/healthy',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/healthy': server },
      sessions: { 'thread-deleted': session },
      queues: {},
    };
    const client = { id: 'healthy-client' };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
        state.servers[projectPath] = nextServer;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };
    const notifyThread = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/healthy' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => client),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => client),
      healthCheck: vi.fn(() => true),
      notifyThread,
      threadExists: vi.fn(() => false),
    });

    expect(stateManager.setSession).toHaveBeenCalledWith('thread-deleted', { ...session, status: 'ended' });
    expect(streamHandler.subscribe).not.toHaveBeenCalled();
    expect(notifyThread).not.toHaveBeenCalled();
  });

  it('auto-connects only unattached sessions found during startup reconciliation', async () => {
    const knownSession: SessionState = {
      sessionId: 'known-session',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/eager',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const newSession = { id: 'new-session', title: 'Created while offline' };
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [{ id: 'known-session' }, newSession] })),
      },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({
          version: 1,
          servers: {},
          sessions: { 'thread-known': knownSession },
          queues: {},
        })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });

    expect(client.session.list).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', newSession, client);
  });

  it('uses a healthy recovered server client for session recovery when ServerManager has no client', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-1': session },
      queues: {},
    };
    const recoveredClient = { id: 'recovered-client' };
    const streamHandler = { subscribe: vi.fn() };
    const notifyThread = vi.fn();
    const cacheManager = { refresh: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
          state.servers[projectPath] = nextServer;
        }),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn((threadId: string) => state.sessions[threadId]),
        setSession: vi.fn((threadId: string, nextSession: SessionState) => {
          state.sessions[threadId] = nextSession;
        }),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
      },
      cacheManager,
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
      threadExists: vi.fn(() => true),
      notifyThread,
    });

    expect(cacheManager.refresh).toHaveBeenCalledWith('/project/recovered', recoveredClient);
    expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', recoveredClient, undefined, '/project/recovered');
    expect(notifyThread).toHaveBeenCalledWith('thread-1', 'Bot restarted. Session reconnected.');
  });

  it('registers healthy recovered server clients with ServerManager when supported', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: {},
      queues: {},
    };
    const recoveredClient = { id: 'recovered-client' };
    const registerRecovered = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
        registerRecovered,
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), on: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
    });

    expect(registerRecovered).toHaveBeenCalledWith('/project/recovered', recoveredClient, server);
  });

  it('uses the default Discord client to find recovered threads and post restart notices', async () => {
    const calls: string[] = [];
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-1': session },
      queues: {},
    };
    const recoveredClient = { id: 'recovered-client' };
    const thread = {
      send: vi.fn(async (message: string) => {
        calls.push(`thread.send:${message}`);
      }),
    };
    const discordClient = {
      login: vi.fn(async () => {
        calls.push('discord.login');
      }),
      channels: {
        fetch: vi.fn(async (threadId: string) => {
          calls.push(`channels.fetch:${threadId}`);
          return thread;
        }),
      },
    };
    const streamHandler = {
      subscribe: vi.fn(async (threadId: string, sessionId: string, client: unknown) => {
        void client;
        calls.push(`stream.subscribe:${threadId}:${sessionId}`);
      }),
    };
    const createStreamHandler = vi.fn((options: { getThread(threadId: string): Promise<unknown> | unknown }) => {
      return {
        subscribe: vi.fn(async (threadId: string, sessionId: string, client: unknown) => {
          expect(await options.getThread(threadId)).toBe(thread);
          await streamHandler.subscribe(threadId, sessionId, client);
        }),
      };
    });

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
          state.servers[projectPath] = nextServer;
        }),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn((threadId: string) => state.sessions[threadId]),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      createStreamHandler,
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
    });

    expect(createStreamHandler).toHaveBeenCalledOnce();
    expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', recoveredClient);
    expect(thread.send).toHaveBeenCalledWith('Bot restarted. Session reconnected.');
    expect(calls.indexOf('discord.login')).toBeLessThan(calls.indexOf('stream.subscribe:thread-1:session-1'));
  });

  it('reuses a recovered healthy client for an autoConnect project instead of starting another server', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const recoveredClient = {
      session: {
        list: vi.fn(async () => []),
      },
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/eager': server },
      sessions: {},
      queues: {},
    };
    const ensureRunning = vi.fn(async () => ({ id: 'duplicate-client' }));
    const cacheManager = { refresh: vi.fn() };
    const subscribeProjectEvents = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
          state.servers[projectPath] = nextServer;
        }),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning,
        getClient: vi.fn(() => undefined),
      },
      cacheManager,
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
      subscribeProjectEvents,
    });

    expect(ensureRunning).not.toHaveBeenCalled();
    expect(cacheManager.refresh).toHaveBeenCalledWith('/project/eager', recoveredClient);
    expect(subscribeProjectEvents).toHaveBeenCalledWith('/project/eager', recoveredClient);
    expect(recoveredClient.session.list).toHaveBeenCalledOnce();
  });

  it('subscribes to project events by default and auto-connects unattached session.created events', async () => {
    const knownSession: SessionState = {
      sessionId: 'known-session',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/eager',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const newSession = { id: 'new-session', title: 'Created from event' };
    async function* events(): AsyncIterable<unknown> {
      yield { payload: { type: 'session.created', info: { id: 'known-session' } } };
      yield { payload: { type: 'session.created', info: newSession } };
    }
    const client = {
      global: { event: vi.fn(() => events()) },
      session: { list: vi.fn(async () => []) },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({ version: 1, servers: {}, sessions: { 'thread-known': knownSession }, queues: {} })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.global.event).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', newSession, client);
  });

  it('auto-connects a missed session by default by creating a thread and persisting the mapping', async () => {
    const missedSession = { id: 'missed-session', title: 'Missed offline session' };
    const client = {
      session: { list: vi.fn(async () => [missedSession]) },
    };
    const thread = {
      id: 'thread-auto',
      send: vi.fn(),
    };
    const parentChannel = {
      threads: {
        create: vi.fn(async (options: { name: string }) => {
          expect(options.name).toBe('Missed offline session');
          return thread;
        }),
      },
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn(async () => parentChannel) },
    };
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [
            {
              serverId: 'guild-1',
              channels: [{ channelId: 'channel-auto', projectPath: '/project/eager', autoConnect: true, defaultAgent: 'plan' }],
            },
          ],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      now: vi.fn(() => 12345),
    });

    expect(parentChannel.threads.create).toHaveBeenCalledOnce();
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-auto', {
      sessionId: 'missed-session',
      guildId: 'guild-1',
      channelId: 'channel-auto',
      projectPath: '/project/eager',
      agent: 'plan',
      model: null,
      createdBy: 'auto-connect',
      createdAt: 12345,
      lastActivityAt: 12345,
      status: 'active',
    });
    expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-auto', 'missed-session', client, undefined, '/project/eager');
    expect(thread.send).toHaveBeenCalledWith('Auto-connected to session `missed-session`.');
  });

  it('marks a recovered active session ended when default Discord thread fetch rejects', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-missing': session },
      queues: {},
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({
        login: vi.fn(),
        channels: { fetch: vi.fn(async () => { throw new Error('missing thread'); }) },
      })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => ({ id: 'recovered-client' })),
      healthCheck: vi.fn(() => true),
    });

    expect(stateManager.setSession).toHaveBeenCalledWith('thread-missing', { ...session, status: 'ended' });
    expect(streamHandler.subscribe).not.toHaveBeenCalled();
  });
});
