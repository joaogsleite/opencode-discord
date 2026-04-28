import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { CacheManager } from '../../opencode/cache.js';
import type { QueueEntry, SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;
const EMBED_FIELD_VALUE_LIMIT = 1024;

interface InfoStateManager {
  getSession(threadId: string): SessionState | undefined;
  getQueue(threadId: string): QueueEntry[];
}

/** Dependencies for the /info command handler. */
export interface InfoCommandDependencies {
  stateManager: InfoStateManager;
  serverManager: { getClient(projectPath: string): unknown };
  cacheManager: Pick<CacheManager, 'getMcpStatus'>;
  now?: () => number;
}

/**
 * Create a handler for showing session details.
 * @param deps - State, server, and cache dependencies.
 * @returns Discord command handler.
 */
export function createInfoCommandHandler(deps: InfoCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const threadId = requireThreadId(interaction);
    const session = requireSession(deps.stateManager.getSession(threadId), threadId);
    const queueLength = deps.stateManager.getQueue(threadId).length;
    await interaction.deferReply();
    const mcpStatus = deps.cacheManager.getMcpStatus(session.projectPath);
    const usage = await getUsage(deps.serverManager.getClient(session.projectPath), session.sessionId);
    const embed = new EmbedBuilder()
      .setTitle('Session Info')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Session', value: truncateFieldValue(session.sessionId), inline: true },
        { name: 'Agent', value: truncateFieldValue(session.agent), inline: true },
        { name: 'Model', value: truncateFieldValue(session.model ?? 'default'), inline: true },
        { name: 'Project', value: truncateFieldValue(session.projectPath), inline: false },
        { name: 'Status', value: truncateFieldValue(session.status), inline: true },
        { name: 'Uptime', value: truncateFieldValue(formatDuration((deps.now ?? Date.now)() - session.createdAt)), inline: true },
        { name: 'Queue', value: String(queueLength), inline: true },
        { name: 'MCP', value: truncateFieldValue(formatMcp(mcpStatus)), inline: false },
        { name: 'Usage', value: truncateFieldValue(usage), inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
  };
}

function requireThreadId(interaction: ChatInputCommandInteraction): string {
  if (!(interaction.channel as { parentId?: string | null } | null)?.parentId) {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'This command can only be used in an OpenCode session thread.');
  }

  return interaction.channelId;
}

function requireSession(session: SessionState | undefined, threadId: string): SessionState {
  if (!session || session.status === 'ended') {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active OpenCode session is attached to this thread.', { threadId });
  }

  return session;
}

function formatMcp(status: Record<string, unknown>): string {
  const entries = Object.entries(status);
  return entries.length > 0 ? entries.map(([name, value]) => `${name}: ${getStatus(value)}`).join('\n') : 'Unavailable';
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function getStatus(value: unknown): string {
  const status = value && typeof value === 'object' ? (value as Record<string, unknown>).status : undefined;
  if (typeof status === 'string') {
    return status;
  }

  return 'unknown';
}

function truncateFieldValue(value: string): string {
  const marker = '... truncated';
  return value.length <= EMBED_FIELD_VALUE_LIMIT ? value : `${value.slice(0, EMBED_FIELD_VALUE_LIMIT - marker.length)}${marker}`;
}

async function getUsage(client: unknown, sessionId: string): Promise<string> {
  try {
    const messages = await (client as { session?: { messages(options: { sessionID: string }): Promise<unknown> } }).session?.messages({ sessionID: sessionId });
    const unwrapped = unwrapArray(messages);
    const cost = unwrapped.reduce<number>((total, message) => total + getNumber(message, 'cost'), 0);
    const tokens = unwrapped.reduce<number>((total, message) => total + getTokens(message), 0);
    return `Tokens: ${tokens}\nCost: $${cost.toFixed(4)}`;
  } catch {
    return 'Tokens: unavailable\nCost: unavailable';
  }
}

function unwrapArray(value: unknown): unknown[] {
  const data = value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value;
  return Array.isArray(data) ? data : [];
}

function getNumber(value: unknown, key: string): number {
  const numberValue = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof numberValue === 'number' ? numberValue : 0;
}

function getTokens(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  const tokens = (value as Record<string, unknown>).tokens;
  if (typeof tokens === 'number') {
    return tokens;
  }

  if (tokens && typeof tokens === 'object') {
    return Object.values(tokens).reduce((total, token) => total + (typeof token === 'number' ? token : 0), 0);
  }

  return 0;
}
