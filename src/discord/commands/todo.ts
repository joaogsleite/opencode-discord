import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface CommandContext { correlationId: string }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface TodoClient { session: { todo(options: { sessionID: string }): Promise<unknown> } }
interface TodoItem { content?: string; title?: string; status?: string }

/** Dependencies for the /todo command handler. */
export interface TodoCommandDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined };
  serverManager: { getClient(projectPath: string): unknown | undefined };
}

/**
 * Create a handler for showing session todos.
 * @param deps - State and server dependencies.
 * @returns Discord command handler.
 */
export function createTodoCommandHandler(deps: TodoCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps.serverManager, session.projectPath);
    await interaction.deferReply();
    const todos = unwrapTodos(await client.session.todo({ sessionID: session.sessionId }));
    const description = todos.length ? todos.map(formatTodo).join('\n') : 'No todos.';
    const embed = new EmbedBuilder().setTitle('Session Todos').setColor(0x5865f2).setDescription(description.slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
  };
}

function formatTodo(todo: TodoItem): string {
  const indicator = todo.status === 'completed' ? '[x]' : todo.status === 'in-progress' || todo.status === 'in_progress' ? '[~]' : '[ ]';
  return `${indicator} ${todo.content ?? todo.title ?? 'Untitled todo'}`;
}

function unwrapTodos(value: unknown): TodoItem[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : value;
  return Array.isArray(data) ? data.filter(isRecord) as TodoItem[] : [];
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: TodoCommandDependencies['stateManager']): SessionState {
  if (!((interaction.channel as { parentId?: string | null } | null)?.parentId)) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Todo can only be used in a session thread.');
  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  return session;
}

function requireClient(serverManager: TodoCommandDependencies['serverManager'], projectPath: string): TodoClient {
  const client = serverManager.getClient(projectPath) as TodoClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
