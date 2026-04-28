import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { BotState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

const EMBED_FIELD_LIMIT = 1024;

interface StatusStateManager {
  getState(): BotState;
}

/** Dependencies for the /status command handler. */
export interface StatusCommandDependencies {
  stateManager: StatusStateManager;
}

/**
 * Create a handler for showing channel-level server and session status.
 * @param deps - State dependency.
 * @returns Discord command handler.
 */
export function createStatusCommandHandler(deps: StatusCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction, context: InteractionContext): Promise<void> => {
    if ((interaction.channel as { parentId?: string | null } | null)?.parentId) {
      throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Status can only be used in a configured project channel.');
    }

    if (!context.channelConfig) {
      throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
    }

    const state = deps.stateManager.getState();
    const server = state.servers[context.channelConfig.projectPath];
    const sessions = Object.entries(state.sessions).filter(([, session]) =>
      session.channelId === context.channelConfig?.channelId && session.projectPath === context.channelConfig.projectPath && session.status === 'active');
    const embed = new EmbedBuilder()
      .setTitle('OpenCode Status')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Server', value: server ? `${server.status} (${server.url})` : 'not running', inline: false },
        { name: 'Active Sessions', value: String(sessions.length), inline: true },
        { name: 'Threads', value: formatSessions(sessions, state), inline: false },
      );

    await interaction.reply({ embeds: [embed] });
  };
}

function formatSessions(sessions: Array<[string, BotState['sessions'][string]]>, state: BotState): string {
  if (sessions.length === 0) {
    return 'No active sessions.';
  }

  const lines: string[] = [];
  for (const [threadId, session] of sessions) {
    const next = `${threadId}: ${session.agent} by <@${session.createdBy}> (queue ${state.queues[threadId]?.length ?? 0})`;
    const suffix = `\n... truncated ${sessions.length - lines.length} sessions`;
    const candidate = [...lines, next].join('\n');
    if (candidate.length + suffix.length > EMBED_FIELD_LIMIT) {
      lines.push(`... truncated ${sessions.length - lines.length} sessions`);
      break;
    }
    lines.push(next);
  }

  return lines.join('\n').slice(0, EMBED_FIELD_LIMIT);
}
