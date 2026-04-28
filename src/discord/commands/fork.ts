import type { ChatInputCommandInteraction } from 'discord.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface CommandContext { correlationId: string }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface ForkClient { session: { fork(options: { sessionID: string; messageID?: string }): Promise<unknown> } }
interface ThreadLike { id: string; send(content: string): Promise<unknown>; url?: string }
interface ParentChannelLike { threads: { create(options: { name: string; autoArchiveDuration?: number; reason?: string }): Promise<ThreadLike> } }

/** Dependencies for the /fork command handler. */
export interface ForkCommandDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined; setSession(threadId: string, session: SessionState): void };
  serverManager: { getClient(projectPath: string): unknown | undefined };
  streamHandler: { subscribe(threadId: string, sessionId: string, client: unknown, dedupeSet?: Set<string>, projectPath?: string): Promise<void> | void };
  now?: () => number;
}

/**
 * Create a handler for forking the current session into a new Discord thread.
 * @param deps - State, server, and stream dependencies.
 * @returns Discord command handler.
 */
export function createForkCommandHandler(deps: ForkCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const currentThread = requireThread(interaction);
    const parent = requireParent(currentThread);
    const session = requireSession(deps.stateManager, interaction.channelId);
    const client = requireClient(deps.serverManager, session.projectPath);
    const messageID = interaction.options.getString('message') ?? undefined;
    const title = interaction.options.getString('title') ?? 'OpenCode fork';

    await interaction.deferReply();
    const forked = await client.session.fork({ sessionID: session.sessionId, messageID });
    const forkedSessionId = getSessionId(forked);
    if (!forkedSessionId) throw new BotError(ErrorCode.FORK_FAILED, 'OpenCode did not return a forked session ID.', { sessionId: session.sessionId });

    const newThread = await parent.threads.create({ name: title.slice(0, 100), autoArchiveDuration: 1440, reason: 'OpenCode session fork' });
    const timestamp = deps.now?.() ?? Date.now();
    deps.stateManager.setSession(newThread.id, { ...session, sessionId: forkedSessionId, createdAt: timestamp, lastActivityAt: timestamp, status: 'active' });
    await deps.streamHandler.subscribe(newThread.id, forkedSessionId, client, new Set<string>(), session.projectPath);
    await newThread.send(`Forked from <#${interaction.channelId}>.`);
    await currentThread.send(`Fork created: <#${newThread.id}>.`);
    await interaction.editReply({ content: `Forked session into <#${newThread.id}>.` });
  };
}

function requireThread(interaction: ChatInputCommandInteraction): ThreadLike & { parentId?: string | null; parent?: ParentChannelLike | null } {
  const channel = interaction.channel as (ThreadLike & { parentId?: string | null; parent?: ParentChannelLike | null }) | null;
  if (!channel?.parentId) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Fork can only be used in a session thread.');
  return channel;
}

function requireParent(thread: { parent?: ParentChannelLike | null }): ParentChannelLike {
  if (!thread.parent) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Unable to create a fork thread from this channel.');
  return thread.parent;
}

function requireSession(stateManager: ForkCommandDependencies['stateManager'], threadId: string): SessionState {
  const session = stateManager.getSession(threadId);
  if (!session || session.status !== 'active') throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId });
  return session;
}

function requireClient(serverManager: ForkCommandDependencies['serverManager'], projectPath: string): ForkClient {
  const client = serverManager.getClient(projectPath) as ForkClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

function getSessionId(value: unknown): string | undefined {
  const data = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(data)) return undefined;
  return typeof data.id === 'string' ? data.id : typeof data.sessionID === 'string' ? data.sessionID : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
