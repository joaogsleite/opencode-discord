import { detectTable, splitMessage } from '../utils/formatter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StreamHandler');

/** OpenCode global event shape used by the stream handler. */
export interface GlobalEventLike {
  directory?: string;
  payload: {
    type: string;
    sessionID?: string;
    messageID?: string;
    partID?: string;
    delta?: string;
    field?: string;
    part?: Record<string, unknown>;
    info?: unknown;
    request?: unknown;
    properties?: Record<string, unknown>;
  };
}

/** OpenCode client subset required for SSE streaming. */
export interface OpenCodeStreamClient {
  global: {
    event(): OpenCodeEventSource | Promise<OpenCodeEventSource>;
  };
}

export type OpenCodeEventSource = AsyncIterable<GlobalEventLike> | { stream: AsyncIterable<GlobalEventLike> };

/** Editable Discord message subset required by streaming. */
export interface StreamMessage {
  /**
   * Edit the current Discord message content.
   * @param content - Updated message content.
   * @returns Discord API edit result.
   */
  edit(content: string): Promise<unknown>;
}

/** Discord thread subset required by streaming. */
export interface StreamThread {
  /**
   * Send a new Discord message to the thread.
   * @param content - Message content to send.
   * @returns Message that can be edited while streaming continues.
   */
  send(content: string): Promise<StreamMessage>;

  /**
   * Send a typing indicator to the thread.
   * @returns Completion once Discord accepts the typing indicator.
   */
  sendTyping?(): Promise<void>;
}

/** Delegate for OpenCode question events. */
export interface QuestionEventDelegate {
  /**
   * Handle a question request from OpenCode.
   * @param threadId - Discord thread ID receiving the stream.
   * @param event - OpenCode question payload.
   * @param client - OpenCode client for replies.
   * @returns Completion once the event is handled.
   */
  handleQuestionEvent(threadId: string, event: unknown, client: OpenCodeStreamClient): Promise<void>;
}

/** Delegate for OpenCode permission events. */
export interface PermissionEventDelegate {
  /**
   * Handle a permission request from OpenCode.
   * @param threadId - Discord thread ID receiving the stream.
   * @param event - OpenCode permission payload.
   * @param client - OpenCode client for replies.
   * @returns Completion once the event is handled.
   */
  handlePermissionEvent(threadId: string, event: unknown, client: OpenCodeStreamClient): Promise<void>;
}

/** Delegate for detected markdown tables. */
export interface TableEventDelegate {
  /**
   * Handle detected table markdown.
   * @param threadId - Discord thread ID receiving the stream.
   * @param markdown - Current streamed markdown containing a table.
   * @returns Completion once the table is handled.
   */
  handleTable(threadId: string, markdown: string): Promise<void>;
}

/** Delegate for auto-connecting newly created OpenCode sessions. */
export interface AutoConnectDelegate {
  /**
   * Check whether a session is already attached to a Discord thread.
   * @param sessionId - OpenCode session ID.
   * @returns True when the session already has a thread mapping.
   */
  isSessionAttached(sessionId: string): boolean;

  /**
   * Handle a newly created OpenCode session for a project.
   * @param projectPath - OpenCode project directory.
   * @param session - Session payload from the OpenCode event.
   * @param client - OpenCode client associated with the stream.
   * @returns Completion once the session is connected or ignored by the delegate.
   */
  handleSessionCreated(projectPath: string, session: unknown, client: OpenCodeStreamClient): Promise<void>;

  /**
   * Recover sessions that may have been missed while SSE was disconnected.
   * @param projectPath - OpenCode project directory.
   * @param client - OpenCode client associated with the stream.
   * @returns Completion once missed sessions are checked.
   */
  recoverMissedSessions?(projectPath: string, client: OpenCodeStreamClient): Promise<void>;
}

/** Options for constructing a stream handler. */
export interface StreamHandlerOptions {
  /**
   * Resolve a Discord thread by ID.
   * @param threadId - Discord thread ID.
   * @returns Thread when available, otherwise undefined.
   */
  getThread(threadId: string): StreamThread | undefined;
  questionHandler: QuestionEventDelegate;
  permissionHandler: PermissionEventDelegate;
  autoConnectHandler?: AutoConnectDelegate;
  tableHandler?: TableEventDelegate;
  editThrottleMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  now?: () => number;
}

interface SubscriptionState {
  cancelled: boolean;
  pumpPromise: Promise<void>;
}

const DEFAULT_EDIT_THROTTLE_MS = 1000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;

/** Streams OpenCode SSE events into Discord thread messages. */
export class StreamHandler {
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly editThrottleMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;

  /**
   * Create a stream handler.
   * @param options - Stream handler dependencies and timing configuration.
   * @returns StreamHandler instance.
   */
  constructor(private readonly options: StreamHandlerOptions) {
    this.editThrottleMs = options.editThrottleMs ?? DEFAULT_EDIT_THROTTLE_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Subscribe a Discord thread to OpenCode SSE events for a session.
   * @param threadId - Discord thread ID to update.
   * @param sessionId - OpenCode session ID to filter.
   * @param client - OpenCode client exposing global events.
   * @param dedupeSet - Optional streamed message dedupe set accepted by SessionBridge.
   * @param projectPath - Optional project directory to filter stream events.
   * @returns Completion once the background stream pump is started.
   */
  async subscribe(
    threadId: string,
    sessionId: string,
    client: OpenCodeStreamClient,
    dedupeSet?: Set<string>,
    projectPath?: string,
  ): Promise<void> {
    const thread = this.options.getThread(threadId);
    if (!thread) {
      return;
    }

    const previous = this.subscriptions.get(threadId);
    if (previous !== undefined) {
      previous.cancelled = true;
    }

    const state: SubscriptionState = {
      cancelled: false,
      pumpPromise: Promise.resolve(),
    };
    this.subscriptions.set(threadId, state);
    state.pumpPromise = this.pump(threadId, sessionId, client, thread, state, dedupeSet, projectPath).catch((error: unknown) => {
      logger.warn('Stream pump stopped after an unrecoverable error', { threadId, sessionId, error });
    });
  }

  /**
   * Wait for the current stream pump to finish, useful for finite test streams.
   * @param threadId - Discord thread ID to wait for.
   * @returns Completion once the current pump settles.
   */
  async waitForIdle(threadId: string): Promise<void> {
    await this.subscriptions.get(threadId)?.pumpPromise;
  }

  /**
   * Stop processing future events for a thread.
   * @param threadId - Discord thread ID to unsubscribe.
   * @returns Nothing.
   */
  unsubscribe(threadId: string): void {
    const state = this.subscriptions.get(threadId);
    if (state) {
      state.cancelled = true;
    }
    this.subscriptions.delete(threadId);
  }

  /**
   * Recover sessions that may have been missed outside the live SSE stream.
   * @param projectPath - OpenCode project directory to recover.
   * @param client - OpenCode client associated with the project.
   * @returns Completion once recovery is delegated or skipped.
   */
  async recoverMissedSessions(projectPath: string, client: OpenCodeStreamClient): Promise<void> {
    if (!this.options.autoConnectHandler?.recoverMissedSessions) {
      return;
    }

    try {
      await this.options.autoConnectHandler.recoverMissedSessions(projectPath, client);
    } catch (error) {
      logger.warn('Failed to recover missed auto-connect sessions', { projectPath, error });
    }
  }

  private async pump(
    threadId: string,
    sessionId: string,
    client: OpenCodeStreamClient,
    thread: StreamThread,
    state: SubscriptionState,
    dedupeSet: Set<string> | undefined,
    projectPath: string | undefined,
  ): Promise<void> {
    const context = this.createContext(threadId, sessionId, client, thread, dedupeSet, projectPath);
    let failures = 0;

    while (!state.cancelled) {
      let receivedEvent = false;
      try {
        const events = getEventStream(await client.global.event());
        for await (const event of events) {
          if (state.cancelled) {
            return;
          }
          receivedEvent = true;
          await this.handleEvent(context, event);
        }
        await this.render(context, true);
        if (state.cancelled) {
          return;
        }
        if (receivedEvent) {
          return;
        }
        failures += 1;
        if (failures > this.maxRetries) {
          await this.safeSend(thread, `Stream disconnected after ${this.maxRetries} retries.`, threadId, sessionId);
          return;
        }
        await this.delay(this.retryDelayMs);
        await this.recoverMissedSessionsAfterReconnect(context);
      } catch {
        await this.safeRender(context);
        if (receivedEvent) {
          failures = 0;
        }
        failures += 1;
        if (failures > this.maxRetries) {
          await this.safeSend(thread, `Stream disconnected after ${this.maxRetries} retries.`, threadId, sessionId);
          return;
        }
        await this.delay(this.retryDelayMs);
        await this.recoverMissedSessionsAfterReconnect(context);
      }
    }
  }

  private createContext(
    threadId: string,
    sessionId: string,
    client: OpenCodeStreamClient,
    thread: StreamThread,
    dedupeSet: Set<string> | undefined,
    projectPath: string | undefined,
  ) {
    return {
      threadId,
      sessionId,
      client,
      thread,
      dedupeSet,
      projectPath,
      aggregate: '',
      parts: new Map<string, string>(),
      currentMessageId: undefined as string | undefined,
      currentMessage: undefined as StreamMessage | undefined,
      sentChunks: 0,
      lastEditAt: Number.NEGATIVE_INFINITY,
      lastRenderedContent: undefined as string | undefined,
      runningTools: new Map<string, string>(),
      tableDetected: false,
    };
  }

  private async handleEvent(context: ReturnType<StreamHandler['createContext']>, event: GlobalEventLike): Promise<void> {
    const { payload } = event;
    if (context.projectPath && event.directory && event.directory !== context.projectPath) {
      return;
    }

    if (payload.type === 'session.created') {
      await this.handleSessionCreated(context, event);
      return;
    }

    if (payload.type === 'session.idle') {
      if (getSessionId(payload) === context.sessionId) {
        await this.render(context, true);
      }
      return;
    }

    if (isSessionScopedEvent(payload.type)) {
      if (getSessionId(payload) !== context.sessionId) {
        return;
      }
      const messageId = getMessageId(payload);
      if (messageId) {
        context.dedupeSet?.add(messageId);
      }
    }

    if (payload.type === 'message.part.delta') {
      await this.switchMessageContext(context, payload);
      await this.handleTextDelta(context, payload);
      return;
    }

    if (payload.type === 'message.part.updated') {
      await this.switchMessageContext(context, payload);
      await this.handlePartUpdated(context, payload);
      return;
    }

    if (payload.type === 'question.asked') {
      await this.options.questionHandler.handleQuestionEvent(context.threadId, getPayloadProperties(payload) ?? payload, context.client);
      return;
    }

    if (payload.type === 'permission.asked') {
      await this.options.permissionHandler.handlePermissionEvent(context.threadId, getPayloadProperties(payload) ?? payload, context.client);
    }
  }

  private async handleTextDelta(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const delta = getPayloadString(payload, 'delta');
    const field = getPayloadString(payload, 'field');
    if (!delta || (field && field !== 'text')) {
      return;
    }

    const partID = getPayloadString(payload, 'partID') ?? 'default';
    context.parts.set(partID, `${context.parts.get(partID) ?? ''}${delta}`);
    context.aggregate += delta;

    if (!context.tableDetected && detectTable(context.aggregate)) {
      context.tableDetected = true;
      await this.handleTable(context);
    }

    await this.render(context);
  }

  private async handlePartUpdated(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const part = getPayloadRecord(payload, 'part');
    if (!part || part.type !== 'tool') {
      return;
    }

    const id = String(part.id ?? part.tool ?? part.name ?? context.runningTools.size);
    const name = String(part.tool ?? part.name ?? id);
    const status = getToolStatus(part);
    if (status === 'running') {
      context.runningTools.set(id, name);
    } else {
      context.runningTools.delete(id);
    }

    await this.render(context, true);
  }

  private async render(context: ReturnType<StreamHandler['createContext']>, forceEdit = false): Promise<void> {
    if (!context.aggregate && context.runningTools.size === 0) {
      return;
    }

    const chunks = splitMessage(context.aggregate || '');
    for (let index = context.sentChunks; index < chunks.length - 1; index += 1) {
      if (context.currentMessage) {
        await context.currentMessage.edit(chunks[index] ?? '');
      } else {
        await context.thread.send(chunks[index] ?? '');
      }
      context.currentMessage = undefined;
      context.sentChunks += 1;
    }

    const content = this.withToolStatus(chunks.at(-1) ?? '', context.runningTools);
    if (!context.currentMessage) {
      context.currentMessage = await context.thread.send(content);
      context.lastEditAt = this.now();
      context.lastRenderedContent = content;
      return;
    }

    const currentTime = this.now();
    if (content !== context.lastRenderedContent && (forceEdit || currentTime - context.lastEditAt >= this.editThrottleMs)) {
      await context.currentMessage.edit(content);
      context.lastEditAt = currentTime;
      context.lastRenderedContent = content;
    }
  }

  private withToolStatus(content: string, runningTools: Map<string, string>): string {
    const tools = [...runningTools.values()];
    if (tools.length === 0) {
      return content;
    }
    return `${content}\n\nRunning: ${tools.join(', ')}`;
  }

  private async switchMessageContext(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const messageId = getMessageId(payload);
    if (!messageId || messageId === context.currentMessageId) {
      return;
    }

    if (context.currentMessageId !== undefined) {
      await this.render(context, true);
      context.aggregate = '';
      context.parts.clear();
      context.currentMessage = undefined;
      context.sentChunks = 0;
      context.lastEditAt = Number.NEGATIVE_INFINITY;
      context.lastRenderedContent = undefined;
      context.runningTools.clear();
      context.tableDetected = false;
    }

    context.currentMessageId = messageId;
  }

  private async safeRender(context: ReturnType<StreamHandler['createContext']>): Promise<void> {
    try {
      await this.render(context, true);
    } catch (error) {
      logger.warn('Failed to render stream update during recovery', { threadId: context.threadId, sessionId: context.sessionId, error });
    }
  }

  private async handleTable(context: ReturnType<StreamHandler['createContext']>): Promise<void> {
    try {
      await this.options.tableHandler?.handleTable(context.threadId, context.aggregate);
    } catch (error) {
      logger.warn('Failed to render detected table', { threadId: context.threadId, sessionId: context.sessionId, error });
    }
  }

  private async handleSessionCreated(context: ReturnType<StreamHandler['createContext']>, event: GlobalEventLike): Promise<void> {
    try {
      const autoConnectHandler = this.options.autoConnectHandler;
      const projectPath = event.directory ?? context.projectPath;
      const session = getPayloadValue(event.payload, 'info');
      const createdSessionId = getCreatedSessionId(session);
      if (!autoConnectHandler || !projectPath || !createdSessionId || autoConnectHandler.isSessionAttached(createdSessionId)) {
        return;
      }

      await autoConnectHandler.handleSessionCreated(projectPath, session, context.client);
    } catch (error) {
      logger.warn('Failed to auto-connect created session', { projectPath: event.directory ?? context.projectPath, error });
    }
  }

  private async recoverMissedSessionsAfterReconnect(context: ReturnType<StreamHandler['createContext']>): Promise<void> {
    if (!context.projectPath) {
      return;
    }

    await this.recoverMissedSessions(context.projectPath, context.client);
  }

  private async safeSend(thread: StreamThread, content: string, threadId: string, sessionId: string): Promise<void> {
    try {
      await thread.send(content);
    } catch (error) {
      logger.warn('Failed to send stream recovery notice', { threadId, sessionId, error });
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

function isSessionScopedEvent(type: string): boolean {
  return type === 'message.part.delta'
    || type === 'message.part.updated'
    || type === 'question.asked'
    || type === 'permission.asked'
    || type === 'session.idle';
}

function getSessionId(payload: GlobalEventLike['payload']): string | undefined {
  const sessionId = getPayloadString(payload, 'sessionID');
  if (sessionId !== undefined) {
    return sessionId;
  }

  const request = getPayloadRecord(payload, 'request');
  if (request && typeof request.sessionID === 'string') {
    return request.sessionID;
  }

  return undefined;
}

function getMessageId(payload: GlobalEventLike['payload']): string | undefined {
  return getPayloadString(payload, 'messageID');
}

function getPayloadRecord(payload: GlobalEventLike['payload'], key: string): Record<string, unknown> | undefined {
  const value = getPayloadValue(payload, key);
  return isRecord(value) ? value : undefined;
}

function getPayloadString(payload: GlobalEventLike['payload'], key: string): string | undefined {
  const value = getPayloadValue(payload, key);
  return typeof value === 'string' ? value : undefined;
}

function getPayloadValue(payload: GlobalEventLike['payload'], key: string): unknown {
  const direct = payload[key as keyof GlobalEventLike['payload']];
  if (direct !== undefined) {
    return direct;
  }

  return getPayloadProperties(payload)?.[key];
}

function getPayloadProperties(payload: GlobalEventLike['payload']): Record<string, unknown> | undefined {
  return isRecord(payload.properties) ? payload.properties : undefined;
}

function getCreatedSessionId(session: unknown): string | undefined {
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

function getToolStatus(part: Record<string, unknown>): string | undefined {
  const directStatus = part.status;
  if (typeof directStatus === 'string') {
    return directStatus;
  }

  const state = part.state;
  if (isRecord(state) && typeof state.status === 'string') {
    return state.status;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize OpenCode SDK event sources to an async iterable stream.
 * @param source - SDK event source returned by global.event.
 * @returns Async iterable of global events.
 */
export function getEventStream(source: OpenCodeEventSource): AsyncIterable<GlobalEventLike> {
  if (isAsyncIterable(source)) {
    return source;
  }

  return source.stream;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<GlobalEventLike> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
