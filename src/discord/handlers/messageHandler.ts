import type { Message } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { downloadAndSave, type DiscordAttachmentLike } from '../../opencode/attachments.js';
import type { StateManager } from '../../state/manager.js';
import type { SessionState } from '../../state/types.js';
import { generateCorrelationId } from '../../utils/logger.js';

/** File metadata consumed from the per-thread context buffer. */
export interface ContextFile {
  path: string;
  url: string;
  mime?: string;
  filename?: string;
}

/** Options passed when sending a Discord message to an OpenCode session. */
export interface SendPromptOptions {
  session: SessionState;
  correlationId: string;
  contextFiles: ContextFile[];
}

/** Handles answers for pending OpenCode questions. */
export interface QuestionAnswerHandler {
  /**
   * Check whether the thread is awaiting a user answer.
   * @param threadId - Discord thread ID
   * @returns True when an OpenCode question is pending
   */
  hasPendingQuestion(threadId: string): boolean;

  /**
   * Handle the next user message as an answer to a pending question.
   * @param threadId - Discord thread ID
   * @param content - User message content
   * @param correlationId - Correlation ID for tracing
   * @returns Nothing
   */
  handleQuestionAnswer(threadId: string, content: string, correlationId: string): Promise<void>;
}

/** Bridges Discord thread messages to OpenCode session prompts. */
export interface SessionPromptBridge {
  /**
   * Check whether the session is currently processing a prompt.
   * @param threadId - Discord thread ID
   * @returns True when a prompt is already in flight
   */
  isBusy(threadId: string): boolean;

  /**
   * Send a user prompt to the active OpenCode session.
   * @param threadId - Discord thread ID
   * @param content - User message content
   * @param options - Session, correlation, and context metadata
   * @returns Nothing
   */
  sendPrompt(threadId: string, content: string, options: SendPromptOptions): Promise<void>;
}

/** Provides pending context files for the next sent prompt. */
export interface ContextBuffer {
  /**
   * Consume all pending context files for a Discord thread.
   * @param threadId - Discord thread ID
   * @returns Context files to attach to the next prompt
   */
  consume(threadId: string): Promise<ContextFile[]>;

  /**
   * Clear pending context files for a Discord thread.
   * @param threadId - Discord thread ID
   * @returns Nothing
   */
  clear?(threadId: string): void;
}

/** Downloads Discord message attachments into files OpenCode can consume. */
export interface AttachmentProvider {
  /**
   * Download attachments for a message and session.
   * @param message - Discord message containing attachments.
   * @param session - Active session that owns attachment storage.
   * @returns Saved files to include with a prompt.
   */
  download(message: Message, session: SessionState): Promise<ContextFile[]>;
}

/** Dependencies for handling Discord messageCreate events. */
export interface MessageHandlerOptions {
  stateManager: StateManager;
  questionHandler: QuestionAnswerHandler;
  sessionBridge: SessionPromptBridge;
  contextBuffer?: ContextBuffer;
  attachmentProvider?: AttachmentProvider;
  now?: () => number;
}

/**
 * Handle Discord messageCreate events for thread passthrough sessions.
 * @param message - Incoming Discord message
 * @param options - Handler dependencies
 * @returns Nothing
 */
export async function handleMessageCreate(
  message: Message,
  options: MessageHandlerOptions,
): Promise<void> {
  if (message.author.bot) {
    return;
  }

  if (!message.channel.isThread()) {
    return;
  }

  const threadId = message.channel.id ?? message.channelId;
  const correlationId = generateCorrelationId(threadId);

  if (options.questionHandler.hasPendingQuestion(threadId)) {
    await options.questionHandler.handleQuestionAnswer(threadId, message.content, correlationId);
    return;
  }

  const storedSession = options.stateManager.getSession(threadId);
  if (!storedSession || storedSession.status === 'ended') {
    return;
  }

  const now = options.now?.() ?? Date.now();
  const session = storedSession.status === 'inactive'
    ? { ...storedSession, status: 'active' as const, lastActivityAt: now }
    : storedSession;

  if (session !== storedSession) {
    options.stateManager.setSession(threadId, session);
  }

  const attachmentFiles = await downloadAttachments(options.attachmentProvider, message, session);

  if (options.sessionBridge.isBusy(threadId)) {
    options.stateManager.enqueue(threadId, {
      userId: message.author.id,
      content: message.content,
      attachments: attachmentFiles.map((file) => file.path),
      queuedAt: now,
    });
    return;
  }

  const contextFiles = options.contextBuffer ? await options.contextBuffer.consume(threadId) : [];
  await options.sessionBridge.sendPrompt(threadId, message.content, {
    session,
    correlationId,
    contextFiles: [...contextFiles, ...attachmentFiles],
  });
}

async function downloadAttachments(
  attachmentProvider: AttachmentProvider | undefined,
  message: Message,
  session: SessionState,
): Promise<ContextFile[]> {
  if (attachmentProvider) {
    return attachmentProvider.download(message, session);
  }

  return Promise.all(getDiscordAttachments(message).map(async (attachment) => {
    const saved = await downloadAndSave(attachment, session.projectPath, { messageId: message.id });
    return {
      path: saved.path,
      url: pathToFileURL(saved.path).href,
      mime: saved.mime,
      filename: saved.filename,
    };
  }));
}

function getDiscordAttachments(message: Message): DiscordAttachmentLike[] {
  return Array.from(message.attachments.values()).map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    name: attachment.name,
    contentType: attachment.contentType,
  }));
}
