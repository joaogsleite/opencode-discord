import type { ChatInputCommandInteraction } from 'discord.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface CommandContext { correlationId: string }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface MessageLike { id?: string; messageID?: string; role?: string; content?: string; text?: string; info?: { id?: string; messageID?: string; role?: string }; parts?: Array<{ type?: string; text?: string; content?: string }> }
interface RetryClient extends OpencodeSessionClient { session: OpencodeSessionClient['session'] & { revert(options: { sessionID: string; messageID: string }): Promise<unknown> } }

/** Dependencies for the /retry command handler. */
export interface RetryCommandDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined };
  serverManager: { getClient(projectPath: string): unknown | undefined };
  sessionBridge: Pick<SessionBridge, 'sendPrompt'>;
}

/**
 * Create a handler for retrying the last user prompt.
 * @param deps - State, server, and session bridge dependencies.
 * @returns Discord command handler.
 */
export function createRetryCommandHandler(deps: RetryCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps.serverManager, session.projectPath);
    await interaction.deferReply();
    const messages = unwrapMessages(await client.session.messages({ sessionID: session.sessionId, limit: 20 }));
    const lastUser = [...messages].reverse().find((message) => getRole(message) === 'user');
    const lastAssistant = [...messages].reverse().find((message) => getRole(message) === 'assistant');

    if (!lastUser) throw new BotError(ErrorCode.NO_MESSAGE_TO_RETRY, 'No previous user message is available to retry.', { sessionId: session.sessionId });
    const assistantId = getMessageId(lastAssistant);
    if (!assistantId) throw new BotError(ErrorCode.NO_MESSAGE_TO_REVERT, 'No assistant message is available to revert.', { sessionId: session.sessionId });

    await client.session.revert({ sessionID: session.sessionId, messageID: assistantId });
    await interaction.editReply({ content: 'Retrying last prompt.' });
    await deps.sessionBridge.sendPrompt(interaction.channelId, { client, content: getText(lastUser) });
  };
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: RetryCommandDependencies['stateManager']): SessionState {
  if (!((interaction.channel as { parentId?: string | null } | null)?.parentId)) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Retry can only be used in a session thread.');
  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  return session;
}

function requireClient(serverManager: RetryCommandDependencies['serverManager'], projectPath: string): RetryClient {
  const client = serverManager.getClient(projectPath) as RetryClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

function unwrapMessages(value: unknown): MessageLike[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : value;
  return Array.isArray(data) ? data.filter(isRecord) as MessageLike[] : [];
}

function getRole(message: MessageLike): string | undefined { return message.role ?? message.info?.role; }
function getMessageId(message: MessageLike | undefined): string | undefined { return message?.id ?? message?.messageID ?? message?.info?.id ?? message?.info?.messageID; }
function getText(message: MessageLike): string { return message.content ?? message.text ?? message.parts?.map((part) => part.text ?? part.content ?? '').join('\n') ?? ''; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
