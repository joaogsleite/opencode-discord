import type { ChatInputCommandInteraction } from 'discord.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface CommandContext { correlationId: string }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface RevertStateManager { getSession(threadId: string): SessionState | undefined }
interface MessageLike { id?: string; messageID?: string; role?: string; content?: string; text?: string; info?: { id?: string; messageID?: string; role?: string }; parts?: Array<{ type?: string; text?: string; content?: string }> }
interface RevertClient { session: { messages(options: { sessionID: string; limit?: number }): Promise<unknown>; revert(options: { sessionID: string; messageID: string }): Promise<unknown>; unrevert(options: { sessionID: string }): Promise<unknown> } }

/** Dependencies for /revert and /unrevert command handlers. */
export interface RevertCommandDependencies {
  stateManager: RevertStateManager;
  serverManager: { getClient(projectPath: string): unknown | undefined };
}

/**
 * Create a handler for reverting an assistant message.
 * @param deps - State and server dependencies.
 * @returns Discord command handler.
 */
export function createRevertCommandHandler(deps: RevertCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps.serverManager, session.projectPath);
    const requested = interaction.options.getString('message');
    const messageID = requested ?? getLastAssistantMessageId(unwrapMessages(await client.session.messages({ sessionID: session.sessionId, limit: 15 })));
    if (!messageID) {
      throw new BotError(ErrorCode.NO_MESSAGE_TO_REVERT, 'No assistant message is available to revert.', { sessionId: session.sessionId });
    }

    await client.session.revert({ sessionID: session.sessionId, messageID });
    await interaction.reply({ content: `Reverted message \`${messageID}\`.` });
  };
}

/**
 * Create a handler for undoing the last session revert.
 * @param deps - State and server dependencies.
 * @returns Discord command handler.
 */
export function createUnrevertCommandHandler(deps: RevertCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps.serverManager, session.projectPath);
    await client.session.unrevert({ sessionID: session.sessionId });
    await interaction.reply({ content: 'Last revert undone.' });
  };
}

/**
 * Build autocomplete choices from assistant messages.
 * @param messages - Recent session messages.
 * @returns Discord autocomplete choices.
 */
export function getRevertAutocompleteChoices(messages: unknown[]): Array<{ name: string; value: string }> {
  return messages.filter(isAssistantMessage).slice(-15).map((message) => ({ name: previewMessage(message), value: getMessageId(message) ?? '' })).filter((choice) => choice.value);
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: RevertStateManager): SessionState {
  if (!((interaction.channel as { parentId?: string | null } | null)?.parentId)) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a session thread.');
  }
  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  }
  return session;
}

function requireClient(serverManager: RevertCommandDependencies['serverManager'], projectPath: string): RevertClient {
  const client = serverManager.getClient(projectPath) as RevertClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

function unwrapMessages(value: unknown): MessageLike[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : value;
  return Array.isArray(data) ? data.filter(isRecord) as MessageLike[] : [];
}

function getLastAssistantMessageId(messages: MessageLike[]): string | undefined {
  return getRevertAutocompleteChoices(messages).at(-1)?.value;
}

function isAssistantMessage(value: unknown): value is MessageLike {
  return isRecord(value) && ((value.role ?? (isRecord(value.info) ? value.info.role : undefined)) === 'assistant');
}

function getMessageId(message: MessageLike): string | undefined {
  return message.id ?? message.messageID ?? message.info?.id ?? message.info?.messageID;
}

function previewMessage(message: MessageLike): string {
  const text = message.content ?? message.text ?? message.parts?.map((part) => part.text ?? part.content ?? '').join(' ') ?? getMessageId(message) ?? 'Assistant message';
  return text.slice(0, 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
