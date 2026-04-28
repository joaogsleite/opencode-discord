import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

/**
 * Create a context-aware help command handler.
 * @returns Discord command handler.
 */
export function createHelpCommandHandler(): CommandHandler {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const inThread = Boolean((interaction.channel as { parentId?: string | null } | null)?.parentId);
    const commands = inThread
      ? ['`/agent set` change this thread agent', '`/agent list` list agents', '`/model set` change this thread model', '`/model list` list models', '`/info` show session details', '`/end` end this session']
      : ['`/new` start a session', '`/connect` attach an existing session', '`/agent list` list agents', '`/model list` list models', '`/status` show channel status'];

    await interaction.reply({ content: commands.join('\n'), ephemeral: true });
  };
}
