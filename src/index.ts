import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { SlashCommandBuilder } from 'discord.js';
import { getCommandDefinitions as defaultGetCommandDefinitions } from './discord/commands/index.js';
import {
  createDiscordClient as defaultCreateDiscordClient,
  registerLifecycleHandlers as defaultRegisterLifecycleHandlers,
} from './discord/client.js';
import type { LifecycleController, LifecycleHandlerOptions } from './discord/client.js';
import { deployCommands as defaultDeployCommands } from './discord/deploy.js';
import { CacheManager } from './opencode/cache.js';
import { ServerManager } from './opencode/serverManager.js';
import { StreamHandler } from './opencode/streamHandler.js';
import type { AutoConnectDelegate, StreamThread } from './opencode/streamHandler.js';
import type { ChannelConfig } from './config/types.js';
import type { BotConfig } from './config/types.js';
import type { BotState, ServerState, SessionState } from './state/types.js';
import type { Logger } from './utils/logger.js';
import { createLogger } from './utils/logger.js';
import { BotError, ErrorCode } from './utils/errors.js';

export { ConfigLoader } from './config/loader.js';
export { StateManager } from './state/manager.js';
import { ConfigLoader } from './config/loader.js';
import { StateManager } from './state/manager.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('startup');

interface ConfigLoaderLike {
  load(): Promise<void> | void;
  getConfig(): BotConfig;
  onChange?(callback: (config: BotConfig) => void): void;
  watch?(options?: { onChannelRemoved?: (guildId: string, channelId: string, channelConfig: ChannelConfig) => Promise<void> | void }): void;
  close?(): Promise<void> | void;
}

interface StateManagerLike {
  load(): void;
  getState(): BotState;
  getServer(projectPath: string): ServerState | undefined;
  setServer(projectPath: string, server: ServerState): void;
  removeServer(projectPath: string): void;
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
  removeSession(threadId: string): void;
  getQueue(threadId: string): unknown[];
  clearQueue(threadId: string): void;
}

interface ServerManagerLike {
  ensureRunning(projectPath: string): Promise<unknown>;
  getClient(projectPath: string): unknown | undefined;
  shutdownAll?(): Promise<void>;
}

interface CacheManagerLike {
  refresh(projectPath: string, client: unknown): Promise<void> | void;
}

interface StreamHandlerLike {
  subscribe(threadId: string, sessionId: string, client: unknown, dedupeSet?: Set<string>, projectPath?: string): Promise<void> | void;
}

interface DiscordClientLike {
  login(token: string): Promise<unknown> | unknown;
  channels?: {
    fetch(channelId: string): Promise<unknown> | unknown;
  };
  destroy?: () => void;
  on?: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
}

interface ProcessLike {
  on(eventName: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(eventName: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Options supplied when constructing the default startup stream handler. */
export interface StartupStreamHandlerOptions {
  getThread(threadId: string): StreamThread | undefined;
  autoConnectHandler?: AutoConnectDelegate;
}

/** Dependency injection options for startup orchestration. */
export interface StartBotOptions {
  configPath?: string;
  statePath?: string;
  configLoader?: ConfigLoaderLike;
  stateManager?: StateManagerLike;
  serverManager?: ServerManagerLike;
  cacheManager?: CacheManagerLike;
  streamHandler?: StreamHandlerLike;
  createStreamHandler?: (options: StartupStreamHandlerOptions) => StreamHandlerLike;
  createDiscordClient?: (token: string) => DiscordClientLike;
  deployCommands?: (token: string, guildId: string, commands: SlashCommandBuilder[]) => Promise<void> | void;
  getCommandDefinitions?: () => SlashCommandBuilder[];
  preflight?: () => Promise<void> | void;
  isPidAlive?: (pid: number) => boolean;
  createClient?: (url: string) => unknown;
  healthCheck?: (client: unknown) => Promise<boolean> | boolean;
  killPid?: (pid: number) => void;
  notifyThread?: (threadId: string, message: string) => Promise<void> | void;
  threadExists?: (threadId: string, session: SessionState) => Promise<boolean> | boolean;
  subscribeProjectEvents?: (projectPath: string, client: unknown) => Promise<void> | void;
  autoConnectSession?: (projectPath: string, session: unknown, client: unknown) => Promise<void> | void;
  registerLifecycleHandlers?: typeof defaultRegisterLifecycleHandlers;
  processLike?: ProcessLike;
  setInterval?: LifecycleHandlerOptions['setInterval'];
  clearInterval?: LifecycleHandlerOptions['clearInterval'];
  exit?: LifecycleHandlerOptions['exit'];
  now?: () => number;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

/** Runtime objects created or used during bot startup. */
export interface StartedBot {
  config: BotConfig;
  stateManager: StateManagerLike;
  serverManager: ServerManagerLike;
  cacheManager: CacheManagerLike;
  discordClient: DiscordClientLike;
  lifecycleController: LifecycleController;
}

/**
 * Start the Discord bot and recover persisted OpenCode runtime state.
 * @param options - Optional injected dependencies and paths for testable startup.
 * @returns Started runtime dependencies for callers that need lifecycle control.
 */
export async function startBot(options: StartBotOptions = {}): Promise<StartedBot> {
  const startupLogger = options.logger ?? logger;
  await (options.preflight ?? defaultPreflight)();

  const stateManager = options.stateManager ?? new StateManager(options.statePath ?? 'state.json');
  stateManager.load();

  const configLoader = options.configLoader ?? new ConfigLoader(options.configPath ?? 'config.yaml');
  await configLoader.load();
  let config = configLoader.getConfig();
  const autoConnectProjects = getAutoConnectProjects(config);
  const serverManager = options.serverManager ?? new ServerManager({ stateManager, autoConnectProjects });
  const cacheManager = options.cacheManager ?? new CacheManager({ logger: startupLogger });
  const discordClient = (options.createDiscordClient ?? defaultCreateDiscordClient)(config.discordToken);
  const threadResolver = createDiscordThreadResolver(discordClient, startupLogger);
  const knownAutoConnectSessionIds = new Set(Object.values(stateManager.getState().sessions).map((session) => session.sessionId));
  let dedupedAutoConnectSession: (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void>;
  const autoConnectSession = options.autoConnectSession ?? ((projectPath: string, session: unknown, client: unknown) =>
    defaultAutoConnectSession(projectPath, session, client, {
      config,
      discordClient,
      now: options.now ?? Date.now,
      rememberThread: threadResolver.remember,
      stateManager,
      streamHandler,
    }));
  const streamHandler = options.streamHandler ?? (options.createStreamHandler ?? createDefaultStreamHandler)({
    getThread: threadResolver.getCached,
    autoConnectHandler: {
      isSessionAttached: (sessionId) => knownAutoConnectSessionIds.has(sessionId) || isSessionAttached(stateManager, sessionId),
      handleSessionCreated: async (projectPath, session, client) => {
        await dedupedAutoConnectSession(projectPath, session, client, knownAutoConnectSessionIds);
      },
      recoverMissedSessions: async (projectPath, client) => {
        await reconcileAutoConnectSessions(projectPath, client, dedupedAutoConnectSession, knownAutoConnectSessionIds, startupLogger);
      },
    },
  });
  dedupedAutoConnectSession = dedupeAutoConnectSession(stateManager, autoConnectSession);

  const recoveredClients = await recoverServers(stateManager, cacheManager, {
    createClient: options.createClient ?? ((url) => createOpencodeClient({ baseUrl: url })),
    healthCheck: options.healthCheck ?? defaultHealthCheck,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    killPid: options.killPid ?? defaultKillPid,
    logger: asLifecycleLogger(startupLogger),
  });
  await discordClient.login(config.discordToken);
  const sessionsSkippedDuringRecovery = await recoverSessions(stateManager, serverManager, streamHandler, {
    logger: asLifecycleLogger(startupLogger),
    recoveredClients,
    notifyThread: options.notifyThread ?? (async (threadId, message) => {
      await sendThreadNotice(threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId), message);
    }),
    threadExists: options.threadExists ?? (async (threadId) => await threadResolver.fetch(threadId) !== undefined),
  });
  recoverQueues(stateManager);
  await startAutoConnectProjects(config, serverManager, cacheManager, recoveredClients, {
    logger: asLifecycleLogger(startupLogger),
    knownSessionIds: knownAutoConnectSessionIds,
    subscribeProjectEvents: options.subscribeProjectEvents === undefined
      ? ((projectPath, client, knownSessionIds) => {
        subscribeToProjectEvents(projectPath, client, stateManager, dedupedAutoConnectSession, startupLogger, knownSessionIds);
      })
      : ((projectPath, client) => options.subscribeProjectEvents?.(projectPath, client)),
    autoConnectSession: dedupedAutoConnectSession,
  });
  await recoverSessions(stateManager, serverManager, streamHandler, {
    logger: asLifecycleLogger(startupLogger),
    recoveredClients,
    notifyThread: options.notifyThread ?? (async (threadId, message) => {
      await sendThreadNotice(threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId), message);
    }),
    threadExists: options.threadExists ?? (async (threadId) => await threadResolver.fetch(threadId) !== undefined),
    threadIds: sessionsSkippedDuringRecovery,
  });

  const commands = (options.getCommandDefinitions ?? defaultGetCommandDefinitions)();
  const deployCommands = options.deployCommands ?? defaultDeployCommands;
  for (const server of config.servers) {
    await deployCommands(config.discordToken, server.serverId, commands);
  }

  configLoader.onChange?.((nextConfig) => {
    config = nextConfig;
    for (const server of nextConfig.servers) {
      void warnOnFailure(startupLogger, 'Failed to deploy Discord commands after config reload', { guildId: server.serverId }, async () => {
        await deployCommands(nextConfig.discordToken, server.serverId, commands);
      });
    }
  });

  const registerLifecycleHandlers = options.registerLifecycleHandlers ?? defaultRegisterLifecycleHandlers;
  const lifecycleClient = options.registerLifecycleHandlers === undefined
    ? asLifecycleClient(discordClient)
    : discordClient as Parameters<typeof defaultRegisterLifecycleHandlers>[0];
  const lifecycleServerManager = options.registerLifecycleHandlers === undefined
    ? {
      shutdownAll: async () => {
        await serverManager.shutdownAll?.();
        await shutdownRecoveredServers(recoveredClients, stateManager, options.killPid ?? defaultKillPid, startupLogger);
      },
    }
    : serverManager as Parameters<typeof defaultRegisterLifecycleHandlers>[1]['serverManager'];
  const lifecycleController = registerLifecycleHandlers(lifecycleClient, {
    stateManager,
    serverManager: lifecycleServerManager,
    abortSession: async (threadId, session) => {
      await abortSessionFromServerManager(serverManager, recoveredClients, threadId, session, startupLogger);
    },
    processLike: options.processLike,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    exit: options.exit,
    now: options.now,
    logger: asLifecycleLogger(startupLogger),
  });

  const startedLifecycleController = configLoader.close === undefined
    ? lifecycleController
    : wrapLifecycleController(lifecycleController, async () => {
      await configLoader.close?.();
    });

  configLoader.watch?.({
    onChannelRemoved: async (guildId, channelId) => {
      await cleanupRemovedChannelSessions(guildId, channelId, stateManager, serverManager, recoveredClients, threadResolver, startupLogger);
    },
  });

  return { config, stateManager, serverManager, cacheManager, discordClient, lifecycleController: startedLifecycleController };
}

interface ServerRecoveryDependencies {
  createClient(url: string): unknown;
  healthCheck(client: unknown): Promise<boolean> | boolean;
  isPidAlive(pid: number): boolean;
  killPid(pid: number): void;
  logger: Pick<Logger, 'warn'>;
}

interface SessionRecoveryDependencies {
  logger: Pick<Logger, 'warn'>;
  recoveredClients: Map<string, unknown>;
  notifyThread?: (threadId: string, message: string) => Promise<void> | void;
  threadExists(threadId: string, session: SessionState): Promise<boolean> | boolean;
  threadIds?: Set<string>;
}

interface AutoConnectDependencies {
  logger: Pick<Logger, 'warn'>;
  knownSessionIds: Set<string>;
  subscribeProjectEvents(projectPath: string, client: unknown, knownSessionIds: Set<string>): Promise<void> | void;
  autoConnectSession(projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>): Promise<void> | void;
}

async function recoverServers(
  stateManager: StateManagerLike,
  cacheManager: CacheManagerLike,
  dependencies: ServerRecoveryDependencies,
): Promise<Map<string, unknown>> {
  const recoveredClients = new Map<string, unknown>();

  for (const [projectPath, server] of Object.entries(stateManager.getState().servers)) {
    if (server.status !== 'running') {
      continue;
    }

    if (!dependencies.isPidAlive(server.pid)) {
      stateManager.setServer(projectPath, { ...server, status: 'stopped' });
      continue;
    }

    const client = dependencies.createClient(server.url);
    if (await dependencies.healthCheck(client)) {
      recoveredClients.set(projectPath, client);
      await warnOnFailure(dependencies.logger, 'Failed to refresh recovered OpenCode cache', { projectPath }, async () => {
        await cacheManager.refresh(projectPath, client);
      });
      continue;
    }

    await warnOnFailure(dependencies.logger, 'Failed to kill unhealthy OpenCode process', { projectPath, pid: server.pid }, async () => {
      dependencies.killPid(server.pid);
    });
    stateManager.setServer(projectPath, { ...server, status: 'stopped' });
  }

  return recoveredClients;
}

async function recoverSessions(
  stateManager: StateManagerLike,
  serverManager: ServerManagerLike,
  streamHandler: StreamHandlerLike,
  dependencies: SessionRecoveryDependencies,
): Promise<Set<string>> {
  const skipped = new Set<string>();

  for (const [threadId, session] of Object.entries(stateManager.getState().sessions)) {
    if (dependencies.threadIds !== undefined && !dependencies.threadIds.has(threadId)) {
      continue;
    }

    if (session.status === 'ended') {
      continue;
    }

    const server = stateManager.getServer(session.projectPath);
    if (server?.status !== 'running') {
      skipped.add(threadId);
      continue;
    }

    const exists = await dependencies.threadExists(threadId, session);
    if (!exists) {
      stateManager.setSession(threadId, { ...session, status: 'ended' });
      continue;
    }

    const client = serverManager.getClient(session.projectPath) ?? dependencies.recoveredClients.get(session.projectPath);
    if (client === undefined) {
      skipped.add(threadId);
      continue;
    }

    await warnOnFailure(dependencies.logger, 'Failed to resubscribe recovered session stream', {
      threadId,
      sessionId: session.sessionId,
      projectPath: session.projectPath,
    }, async () => {
      await streamHandler.subscribe(threadId, session.sessionId, client, undefined, session.projectPath);
    });
    await warnOnFailure(dependencies.logger, 'Failed to post session recovery notice', { threadId }, async () => {
      await dependencies.notifyThread?.(threadId, 'Bot restarted. Session reconnected.');
    });
  }

  return skipped;
}

function recoverQueues(stateManager: StateManagerLike): void {
  for (const [threadId, entries] of Object.entries(stateManager.getState().queues)) {
    if (entries.length > 0 && stateManager.getSession(threadId)?.status === 'ended') {
      stateManager.clearQueue(threadId);
    }
  }
}

async function startAutoConnectProjects(
  config: BotConfig,
  serverManager: ServerManagerLike,
  cacheManager: CacheManagerLike,
  recoveredClients: Map<string, unknown>,
  dependencies: AutoConnectDependencies,
): Promise<void> {
  for (const projectPath of getAutoConnectProjects(config)) {
    const client = recoveredClients.get(projectPath) ?? await serverManager.ensureRunning(projectPath);
    recoveredClients.set(projectPath, client);
    await warnOnFailure(dependencies.logger, 'Failed to refresh auto-connect OpenCode cache', { projectPath }, async () => {
      await cacheManager.refresh(projectPath, client);
    });
    await warnOnFailure(dependencies.logger, 'Failed to subscribe to auto-connect project events', { projectPath }, async () => {
      await dependencies.subscribeProjectEvents(projectPath, client, dependencies.knownSessionIds);
    });
    await warnOnFailure(dependencies.logger, 'Failed to reconcile auto-connect sessions', { projectPath }, async () => {
      const sessions = await listClientSessions(client);
      for (const session of sessions) {
        const sessionId = getSessionId(session);
        if (sessionId === undefined || dependencies.knownSessionIds.has(sessionId)) {
          continue;
        }

        await dependencies.autoConnectSession(projectPath, session, client, dependencies.knownSessionIds);
      }
    });
  }
}

function dedupeAutoConnectSession(
  stateManager: StateManagerLike,
  autoConnectSession: (projectPath: string, session: unknown, client: unknown) => Promise<void> | void,
): (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void> {
  return async (projectPath, session, client, knownSessionIds) => {
    const sessionId = getSessionId(session);
    if (sessionId === undefined || knownSessionIds.has(sessionId) || isSessionAttached(stateManager, sessionId)) {
      return;
    }

    knownSessionIds.add(sessionId);
    try {
      await autoConnectSession(projectPath, session, client);
    } catch (error) {
      if (!isSessionAttached(stateManager, sessionId)) {
        knownSessionIds.delete(sessionId);
      }
      throw error;
    }
  };
}

function subscribeToProjectEvents(
  projectPath: string,
  client: unknown,
  stateManager: StateManagerLike,
  autoConnectSession: (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void> | void,
  subscriptionLogger: Pick<Logger, 'warn'>,
  knownSessionIds = new Set(Object.values(stateManager.getState().sessions).map((session) => session.sessionId)),
): void {
  if (!isRecord(client) || !isRecord(client.global) || typeof client.global.event !== 'function') {
    return;
  }

  void (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const globalApi = client.global;
        if (!isRecord(globalApi) || typeof globalApi.event !== 'function') {
          return;
        }

        const events = await globalApi.event();
        if (!isAsyncIterable(events)) {
          return;
        }

        for await (const event of events) {
          const session = getCreatedSession(event);
          const sessionId = getSessionId(session);
          if (session === undefined || sessionId === undefined || knownSessionIds.has(sessionId)) {
            continue;
          }

          await autoConnectSession(projectPath, session, client, knownSessionIds);
        }
        return;
      } catch (error) {
        subscriptionLogger.warn('Auto-connect project event subscription failed', { projectPath, error });
        await reconcileAutoConnectSessions(projectPath, client, autoConnectSession, knownSessionIds, subscriptionLogger);
      }
    }
  })();
}

async function reconcileAutoConnectSessions(
  projectPath: string,
  client: unknown,
  autoConnectSession: (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void> | void,
  knownSessionIds: Set<string>,
  reconciliationLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  await warnOnFailure(reconciliationLogger, 'Failed to reconcile auto-connect sessions after event disconnect', { projectPath }, async () => {
    const sessions = await listClientSessions(client);
    for (const session of sessions) {
      const sessionId = getSessionId(session);
      if (sessionId === undefined || knownSessionIds.has(sessionId)) {
        continue;
      }

      await autoConnectSession(projectPath, session, client, knownSessionIds);
    }
  });
}

function isSessionAttached(stateManager: StateManagerLike, sessionId: string): boolean {
  return Object.values(stateManager.getState().sessions).some((session) => session.sessionId === sessionId && session.status !== 'ended');
}

function getCreatedSession(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.payload) || event.payload.type !== 'session.created') {
    return undefined;
  }

  return event.payload.info;
}

interface DefaultAutoConnectDependencies {
  config: BotConfig;
  discordClient: DiscordClientLike;
  now: () => number;
  rememberThread?: (threadId: string, thread: unknown) => void;
  stateManager: StateManagerLike;
  streamHandler: StreamHandlerLike;
}

async function defaultAutoConnectSession(
  projectPath: string,
  session: unknown,
  client: unknown,
  dependencies: DefaultAutoConnectDependencies,
): Promise<void> {
  const sessionId = getSessionId(session);
  const channel = getFirstAutoConnectChannel(dependencies.config, projectPath);
  if (sessionId === undefined || channel === undefined || dependencies.discordClient.channels === undefined) {
    return;
  }

  const parentChannel = await dependencies.discordClient.channels.fetch(channel.channel.channelId);
  if (!hasThreadCreate(parentChannel)) {
    return;
  }

  const thread = await parentChannel.threads.create({ name: getSessionTitle(session, sessionId).slice(0, 100) });
  if (!isRecord(thread) || typeof thread.id !== 'string') {
    return;
  }
  dependencies.rememberThread?.(thread.id, thread);

  const timestamp = dependencies.now();
  dependencies.stateManager.setSession(thread.id, {
    sessionId,
    guildId: channel.guildId,
    channelId: channel.channel.channelId,
    projectPath,
    agent: channel.channel.defaultAgent ?? 'build',
    model: null,
    createdBy: 'auto-connect',
    createdAt: timestamp,
    lastActivityAt: timestamp,
    status: 'active',
  });
  await dependencies.streamHandler.subscribe(thread.id, sessionId, client, undefined, projectPath);
  await sendThreadNotice(thread, `Auto-connected to session \`${sessionId}\`.`);
}

function getFirstAutoConnectChannel(config: BotConfig, projectPath: string): { guildId: string; channel: BotConfig['servers'][number]['channels'][number] } | undefined {
  for (const server of config.servers) {
    for (const channel of server.channels) {
      if (channel.projectPath === projectPath && channel.autoConnect === true) {
        return { guildId: server.serverId, channel };
      }
    }
  }

  return undefined;
}

function hasThreadCreate(channel: unknown): channel is { threads: { create(options: { name: string }): Promise<unknown> | unknown } } {
  return isRecord(channel) && isRecord(channel.threads) && typeof channel.threads.create === 'function';
}

function getSessionTitle(session: unknown, sessionId: string): string {
  if (isRecord(session) && typeof session.title === 'string' && session.title.trim() !== '') {
    return session.title;
  }

  return sessionId;
}

async function listClientSessions(client: unknown): Promise<unknown[]> {
  if (!isRecord(client) || !isRecord(client.session) || typeof client.session.list !== 'function') {
    return [];
  }

  const response = await client.session.list();
  const sessions = isRecord(response) && 'data' in response ? response.data : response;
  return Array.isArray(sessions) ? sessions : [];
}

function getSessionId(session: unknown): string | undefined {
  if (!isRecord(session)) {
    return undefined;
  }

  if (typeof session.id === 'string') {
    return session.id;
  }

  if (typeof session.sessionID === 'string') {
    return session.sessionID;
  }

  return undefined;
}

function getAutoConnectProjects(config: BotConfig): Set<string> {
  const projects = new Set<string>();
  for (const server of config.servers) {
    for (const channel of server.channels) {
      if (channel.autoConnect === true) {
        projects.add(channel.projectPath);
      }
    }
  }

  return projects;
}

async function warnOnFailure(
  warningLogger: Pick<Logger, 'warn'>,
  message: string,
  meta: Record<string, unknown>,
  operation: () => Promise<void> | void,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    warningLogger.warn(message, { ...meta, error });
  }
}

interface ThreadResolver {
  fetch(threadId: string): Promise<unknown>;
  getCached(threadId: string): StreamThread | undefined;
  remember(threadId: string, thread: unknown): void;
}

function createDiscordThreadResolver(discordClient: DiscordClientLike, resolverLogger: Pick<Logger, 'warn'>): ThreadResolver {
  const threads = new Map<string, unknown>();

  return {
    async fetch(threadId: string): Promise<unknown> {
      if (threads.has(threadId)) {
        return threads.get(threadId);
      }

      if (discordClient.channels === undefined) {
        return undefined;
      }

      let thread: unknown;
      try {
        thread = await discordClient.channels.fetch(threadId);
      } catch (error) {
        resolverLogger.warn('Failed to fetch Discord thread during startup recovery', { threadId, error });
        return undefined;
      }

      if (thread !== undefined && thread !== null) {
        threads.set(threadId, thread);
      }

      return thread;
    },
    getCached(threadId: string): StreamThread | undefined {
      const thread = threads.get(threadId);
      return isStreamThread(thread) ? thread : undefined;
    },
    remember(threadId: string, thread: unknown): void {
      threads.set(threadId, thread);
    },
  };
}

function isStreamThread(thread: unknown): thread is StreamThread {
  return isRecord(thread) && typeof thread.send === 'function';
}

function createDefaultStreamHandler(options: StartupStreamHandlerOptions): StreamHandlerLike {
  return new StreamHandler({
    getThread: options.getThread,
    questionHandler: { handleQuestionEvent: async () => {} },
    permissionHandler: { handlePermissionEvent: async () => {} },
    autoConnectHandler: options.autoConnectHandler,
  });
}

async function abortSessionFromServerManager(
  serverManager: ServerManagerLike,
  recoveredClients: Map<string, unknown>,
  threadId: string,
  session: SessionState,
  abortLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  const client = serverManager.getClient(session.projectPath) ?? recoveredClients.get(session.projectPath);
  if (!isRecord(client) || !isRecord(client.session) || typeof client.session.abort !== 'function') {
    return;
  }

  const sessionApi = client.session as { abort(options: { sessionID: string }): Promise<void> | void };
  await warnOnFailure(abortLogger, 'Failed to abort OpenCode session during lifecycle shutdown', {
    threadId,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
  }, async () => {
    await sessionApi.abort({ sessionID: session.sessionId });
  });
}

async function cleanupRemovedChannelSessions(
  guildId: string,
  channelId: string,
  stateManager: StateManagerLike,
  serverManager: ServerManagerLike,
  recoveredClients: Map<string, unknown>,
  threadResolver: ThreadResolver,
  cleanupLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  for (const [threadId, session] of Object.entries(stateManager.getState().sessions)) {
    if (session.guildId !== guildId || session.channelId !== channelId || session.status === 'ended') {
      continue;
    }

    await abortSessionFromServerManager(serverManager, recoveredClients, threadId, session, cleanupLogger);
    stateManager.setSession(threadId, { ...session, status: 'ended' });
    stateManager.clearQueue(threadId);
    const thread = threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId);
    await warnOnFailure(cleanupLogger, 'Failed to notify removed-channel thread cleanup', { threadId }, async () => {
      await sendThreadNotice(thread, 'Channel removed from config. Session ended.');
    });
    await warnOnFailure(cleanupLogger, 'Failed to archive removed-channel thread', { threadId }, async () => {
      if (hasSetArchived(thread)) {
        await thread.setArchived(true);
      }
    });
  }
}

function wrapLifecycleController(
  lifecycleController: LifecycleController,
  cleanup: () => Promise<void>,
): LifecycleController {
  const closeWatcher = async (): Promise<void> => {
    await cleanup();
  };

  return {
    runInactivityCheck: () => lifecycleController.runInactivityCheck(),
    shutdown: async () => {
      await closeWatcher();
      await lifecycleController.shutdown();
    },
    dispose: () => {
      void closeWatcher();
      lifecycleController.dispose();
    },
  };
}

async function shutdownRecoveredServers(
  recoveredClients: Map<string, unknown>,
  stateManager: StateManagerLike,
  killPid: (pid: number) => void,
  shutdownLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  for (const projectPath of recoveredClients.keys()) {
    const server = stateManager.getState().servers[projectPath];
    if (server === undefined || server.status !== 'running') {
      continue;
    }

    await warnOnFailure(shutdownLogger, 'Failed to kill recovered OpenCode process during lifecycle shutdown', {
      projectPath,
      pid: server.pid,
    }, () => {
      killPid(server.pid);
    });
    stateManager.setServer(projectPath, { ...server, status: 'stopped' });
  }
}

function asLifecycleLogger(startupLogger: Pick<Logger, 'warn' | 'error'>): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg, meta) => startupLogger.warn(msg, meta),
    error: (msg, meta) => startupLogger.error(msg, meta),
  };
}

function asLifecycleClient(discordClient: DiscordClientLike): Parameters<typeof defaultRegisterLifecycleHandlers>[0] {
  return {
    channels: {
      fetch: async (threadId: string) => {
        const thread = await discordClient.channels?.fetch(threadId);
        return hasSetArchived(thread) ? thread : null;
      },
    },
    destroy: () => {
      discordClient.destroy?.();
    },
    on: (eventName, listener) => {
      discordClient.on?.(eventName, listener as (...args: unknown[]) => void);
    },
    off: (eventName, listener) => {
      discordClient.off?.(eventName, listener as (...args: unknown[]) => void);
    },
  };
}

function hasSetArchived(thread: unknown): thread is { setArchived(archived: boolean): Promise<unknown> } {
  return isRecord(thread) && typeof thread.setArchived === 'function';
}

async function sendThreadNotice(thread: unknown, message: string): Promise<void> {
  if (!isRecord(thread) || typeof thread.send !== 'function') {
    return;
  }

  await thread.send(message);
}

async function defaultPreflight(): Promise<void> {
  try {
    await execFileAsync('opencode', ['--version']);
  } catch (error) {
    throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode CLI was not found in PATH. Install opencode before starting the bot.', {
      error,
    });
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number): void {
  process.kill(pid, 'SIGKILL');
}

async function defaultHealthCheck(client: unknown): Promise<boolean> {
  if (!isRecord(client) || !isRecord(client.global) || typeof client.global.health !== 'function') {
    return false;
  }

  try {
    const result = await client.global.health();
    return isRecord(result) && (result.healthy === true || (isRecord(result.data) && result.data.healthy === true));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
