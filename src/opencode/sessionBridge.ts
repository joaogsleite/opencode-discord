import type { FilePartInput, TextPartInput } from '@opencode-ai/sdk/v2';
import type { SessionState } from '../state/types.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { formatHistoryMessage } from '../utils/formatter.js';

type MaybeWrapped<T> = T | { data: T };
type SessionLike = { id?: string; sessionID?: string } | null | undefined;
type SdkErrorEnvelope = { error?: unknown };
type MessageLike = {
  id?: string;
  messageID?: string;
  role?: string;
  content?: string;
  text?: string;
  info?: { id?: string; messageID?: string; role?: string };
  parts?: Array<{ type?: string; text?: string; content?: string }>;
};

/** Structural subset of StateManager used by the session bridge. */
export interface SessionStateManager {
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
}

/** Structural OpenCode SDK v2 session client used by the session bridge. */
export interface OpencodeSessionClient {
  session: {
    create(options: { title?: string }): Promise<MaybeWrapped<SessionLike>>;
    get(options: { sessionID: string }): Promise<MaybeWrapped<SessionLike>>;
    abort(options: { sessionID: string }): Promise<unknown>;
    messages(options: { sessionID: string; limit?: number }): Promise<MaybeWrapped<MessageLike[]>>;
    promptAsync(options: {
      sessionID: string;
      parts: Array<TextPartInput | FilePartInput>;
      agent: string;
      model?: { providerID?: string; modelID: string };
    }): Promise<unknown>;
  };
}

/** Minimal stream subscriber contract implemented by the later stream handler task. */
export interface StreamSubscriber {
  subscribe(threadId: string, sessionId: string, client: OpencodeSessionClient, dedupeSet?: Set<string>): Promise<void> | void;
}

/** Constructor options for SessionBridge. */
export interface SessionBridgeOptions {
  stateManager: SessionStateManager;
  streamSubscriber: StreamSubscriber;
  now?: () => number;
}

/** Options for creating and mapping a new OpenCode session. */
export interface CreateSessionOptions {
  client: OpencodeSessionClient;
  threadId: string;
  guildId: string;
  channelId: string;
  projectPath: string;
  agent: string;
  model?: string | null;
  createdBy: string;
  title?: string;
}

/** File attachment prompt input. */
export interface PromptFile {
  url: string;
  mime: string;
  filename?: string;
}

/** Options for sending a prompt to a mapped session. */
export interface SendPromptOptions {
  client: OpencodeSessionClient;
  content: string;
  files?: PromptFile[];
  agent?: string;
  model?: string | null;
}

/** Minimal Discord thread-like history replay target. */
export interface HistoryThreadLike {
  send(content: string): Promise<unknown>;
}

/** Options for connecting a Discord thread to an existing session. */
export interface ConnectToSessionOptions {
  client: OpencodeSessionClient;
  threadId: string;
  guildId: string;
  channelId: string;
  projectPath: string;
  sessionId: string;
  agent: string;
  model?: string | null;
  createdBy: string;
  historyLimit?: number;
  thread: HistoryThreadLike;
}

/** Bridges Discord thread mappings to OpenCode SDK session operations. */
export class SessionBridge {
  private readonly stateManager: SessionStateManager;
  private readonly streamSubscriber: StreamSubscriber;
  private readonly now: () => number;

  /**
   * Create a session bridge.
   * @param options - Bridge dependencies and optional clock.
   */
  public constructor(options: SessionBridgeOptions) {
    this.stateManager = options.stateManager;
    this.streamSubscriber = options.streamSubscriber;
    this.now = options.now ?? Date.now;
  }

  /**
   * Create an OpenCode session and persist its Discord thread mapping.
   * @param options - Session creation and mapping details.
   * @returns Persisted session state.
   */
  public async createSession(options: CreateSessionOptions): Promise<SessionState> {
    const created = unwrap(await options.client.session.create({ title: options.title }));
    const sessionId = getSessionId(created);

    if (!sessionId) {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode did not return a session ID', { threadId: options.threadId });
    }

    const state = this.buildSessionState(options, sessionId);
    this.stateManager.setSession(options.threadId, state);
    return state;
  }

  /**
   * Send a text prompt and optional files to a mapped session.
   * @param threadId - Discord thread ID mapped to the session.
   * @param options - Prompt content, files, and SDK client.
   * @returns Nothing.
   */
  public async sendPrompt(threadId: string, options: SendPromptOptions): Promise<void> {
    const session = this.requireActiveSession(threadId);
    const parts: Array<TextPartInput | FilePartInput> = [
      { type: 'text', text: options.content },
      ...(options.files ?? []).map((file) => ({ type: 'file' as const, mime: file.mime, url: file.url, filename: file.filename })),
    ];
    const model = parseModel(options.model ?? session.model);

    const result = await options.client.session.promptAsync({
      sessionID: session.sessionId,
      parts,
      agent: options.agent ?? session.agent,
      ...model,
    });
    assertNoSdkError(result, 'OpenCode prompt failed', { threadId, sessionId: session.sessionId });

    this.stateManager.setSession(threadId, { ...session, lastActivityAt: this.now() });
  }

  /**
   * Connect a Discord thread to an existing OpenCode session and replay history.
   * @param options - Existing session and thread mapping details.
   * @returns Nothing.
   */
  public async connectToSession(options: ConnectToSessionOptions): Promise<void> {
    await this.verifySession(options.client, options.sessionId);

    const state = this.buildSessionState(options, options.sessionId);
    this.stateManager.setSession(options.threadId, state);

    const dedupeSet = new Set<string>();
    await this.streamSubscriber.subscribe(options.threadId, options.sessionId, options.client, dedupeSet);

    if ((options.historyLimit ?? 0) > 0) {
      try {
        await this.replayMessages(options.client, options.thread, dedupeSet, { sessionID: options.sessionId, limit: options.historyLimit });
      } catch {
        // History replay is best-effort; connecting should still succeed.
      }
    }

    try {
      await this.replayMessages(options.client, options.thread, dedupeSet, { sessionID: options.sessionId });
    } catch {
      // Gap recovery is also best-effort.
    }

    await options.thread.send(`Connected to session \`${options.sessionId}\`.`);
  }

  /**
   * Abort a mapped OpenCode session through the SDK.
   * @param threadId - Discord thread ID mapped to the session.
   * @param client - OpenCode SDK client.
   * @returns Nothing.
   */
  public async abortSession(threadId: string, client: OpencodeSessionClient): Promise<void> {
    const session = this.requireActiveSession(threadId);
    const result = await client.session.abort({ sessionID: session.sessionId });
    assertNoSdkError(result, 'OpenCode abort failed', { threadId, sessionId: session.sessionId });
  }

  private buildSessionState(options: CreateSessionOptions | ConnectToSessionOptions, sessionId: string): SessionState {
    const timestamp = this.now();

    return {
      sessionId,
      guildId: options.guildId,
      channelId: options.channelId,
      projectPath: options.projectPath,
      agent: options.agent,
      model: options.model ?? null,
      createdBy: options.createdBy,
      createdAt: timestamp,
      lastActivityAt: timestamp,
      status: 'active',
    };
  }

  private requireActiveSession(threadId: string): SessionState {
    const session = this.stateManager.getSession(threadId);

    if (!session || session.status === 'ended') {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active OpenCode session is attached to this thread', { threadId });
    }

    return session;
  }

  private async verifySession(client: OpencodeSessionClient, sessionId: string): Promise<void> {
    try {
      const session = unwrap(await client.session.get({ sessionID: sessionId }));
      if (!session) {
        throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode session was not found', { sessionId });
      }
    } catch (error) {
      if (error instanceof BotError) {
        throw error;
      }

      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode session was not found', { sessionId });
    }
  }

  private async replayMessages(
    client: OpencodeSessionClient,
    thread: HistoryThreadLike,
    dedupeSet: Set<string>,
    options: { sessionID: string; limit?: number },
  ): Promise<void> {
    const messages = unwrap(await client.session.messages(options));

    for (const message of [...messages].reverse()) {
      const messageId = getMessageId(message);
      if (messageId && dedupeSet.has(messageId)) {
        continue;
      }

      const content = getMessageContent(message);
      if (content) {
        await thread.send(formatHistoryMessage(getMessageRole(message), content));
      }

      if (messageId) {
        dedupeSet.add(messageId);
      }
    }
  }
}

function unwrap<T>(value: MaybeWrapped<T>): T {
  if (value && typeof value === 'object' && 'data' in value) {
    return value.data;
  }

  return value;
}

function getSessionId(session: SessionLike): string | undefined {
  return session?.id ?? session?.sessionID;
}

function parseModel(model: string | null | undefined): { model?: { providerID?: string; modelID: string } } {
  if (!model) {
    return {};
  }

  const separatorIndex = model.indexOf('/');
  if (separatorIndex === -1) {
    return { model: { modelID: model } };
  }

  return {
    model: {
      providerID: model.slice(0, separatorIndex),
      modelID: model.slice(separatorIndex + 1),
    },
  };
}

function getMessageId(message: MessageLike): string | undefined {
  return message.info?.id ?? message.info?.messageID ?? message.id ?? message.messageID;
}

function getMessageRole(message: MessageLike): string {
  return message.info?.role ?? message.role ?? 'assistant';
}

function getMessageContent(message: MessageLike): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (typeof message.text === 'string') {
    return message.text;
  }

  return (message.parts ?? [])
    .filter((part) => !part.type || part.type === 'text')
    .map((part) => part.text ?? part.content ?? '')
    .filter(Boolean)
    .join('\n');
}

function assertNoSdkError(result: unknown, message: string, context: Record<string, unknown>): void {
  if (result && typeof result === 'object' && 'error' in result && (result as SdkErrorEnvelope).error) {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, message, { ...context, sdkError: (result as SdkErrorEnvelope).error });
  }
}
