import { detectTable, splitMessage } from '../utils/formatter.js';

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
  };
}

/** OpenCode client subset required for SSE streaming. */
export interface OpenCodeStreamClient {
  global: {
    event(): AsyncIterable<GlobalEventLike> | Promise<AsyncIterable<GlobalEventLike>>;
  };
}

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
  handleQuestionEvent(threadId: string, event: GlobalEventLike['payload'], client: OpenCodeStreamClient): Promise<void>;
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
  handlePermissionEvent(threadId: string, event: GlobalEventLike['payload'], client: OpenCodeStreamClient): Promise<void>;
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

    const state: SubscriptionState = {
      cancelled: false,
      pumpPromise: Promise.resolve(),
    };
    this.subscriptions.set(threadId, state);
    state.pumpPromise = this.pump(threadId, sessionId, client, thread, state, dedupeSet, projectPath);
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
      try {
        const events = await client.global.event();
        for await (const event of events) {
          if (state.cancelled) {
            return;
          }
          await this.handleEvent(context, event);
        }
        await this.render(context, true);
        return;
      } catch {
        await this.render(context, true);
        failures += 1;
        if (failures > this.maxRetries) {
          await thread.send(`Stream disconnected after ${this.maxRetries} retries.`);
          return;
        }
        await this.delay(this.retryDelayMs);
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

    if (isSessionScopedEvent(payload.type)) {
      if (payload.sessionID !== context.sessionId) {
        return;
      }
      if (payload.messageID) {
        context.dedupeSet?.add(payload.messageID);
      }
    }

    if (payload.type === 'message.part.delta') {
      await this.handleTextDelta(context, payload);
      return;
    }

    if (payload.type === 'message.part.updated') {
      await this.handlePartUpdated(context, payload);
      return;
    }

    if (payload.type === 'question.asked') {
      await this.options.questionHandler.handleQuestionEvent(context.threadId, payload, context.client);
      return;
    }

    if (payload.type === 'permission.asked') {
      await this.options.permissionHandler.handlePermissionEvent(context.threadId, payload, context.client);
    }
  }

  private async handleTextDelta(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    if (!payload.delta || (payload.field && payload.field !== 'text')) {
      return;
    }

    const partID = payload.partID ?? 'default';
    context.parts.set(partID, `${context.parts.get(partID) ?? ''}${payload.delta}`);
    context.aggregate += payload.delta;

    if (!context.tableDetected && detectTable(context.aggregate)) {
      context.tableDetected = true;
      await this.options.tableHandler?.handleTable(context.threadId, context.aggregate);
    }

    await this.render(context);
  }

  private async handlePartUpdated(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const part = payload.part;
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
  return type === 'message.part.delta' || type === 'message.part.updated' || type === 'question.asked' || type === 'permission.asked';
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
