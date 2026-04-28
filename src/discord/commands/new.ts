import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { checkAgentAllowed } from '../../utils/permissions.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

interface ThreadLike {
  id: string;
  send(content: string): Promise<unknown>;
}

interface ThreadCreatableChannel {
  threads: {
    create(options: { name: string; autoArchiveDuration: number; reason: string }): Promise<ThreadLike>;
  };
}

/** Dependencies for the /new command handler. */
export interface NewCommandDependencies {
  serverManager: { ensureRunning(projectPath: string): Promise<unknown> };
  sessionBridge: Pick<SessionBridge, 'createSession' | 'sendPrompt'>;
}

/**
 * Create a handler for starting a new OpenCode session thread.
 * @param deps - Server and session bridge dependencies.
 * @returns Discord command handler.
 */
export function createNewCommandHandler(deps: NewCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction, context: InteractionContext): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const prompt = interaction.options.getString('prompt', true);
    const title = normalizeTitle(interaction.options.getString('title'), prompt);
    const agent = interaction.options.getString('agent') ?? channelConfig.defaultAgent ?? 'build';
    const agentAllowed = checkAgentAllowed(channelConfig, agent);

    if (agentAllowed !== true) {
      throw new BotError(ErrorCode[agentAllowed.reason], agentAllowed.reason === 'AGENT_SWITCH_DISABLED'
        ? 'Agent switching is disabled for this channel.'
        : `Agent \'${agent}\' is not allowed in this channel.`, { agent });
    }

    const channel = requireThreadCreatableChannel(interaction);
    await interaction.deferReply({ ephemeral: true });
    const client = requireOpencodeClient(await deps.serverManager.ensureRunning(channelConfig.projectPath), channelConfig.projectPath);
    const thread = await channel.threads.create({ name: title, autoArchiveDuration: 1440, reason: 'OpenCode session' });

    await deps.sessionBridge.createSession({
      client,
      threadId: thread.id,
      guildId: requireGuildId(interaction),
      channelId: interaction.channelId,
      projectPath: channelConfig.projectPath,
      agent,
      model: null,
      createdBy: interaction.user.id,
      title,
    });
    await deps.sessionBridge.sendPrompt(thread.id, { client, content: prompt, agent, model: null });
    await interaction.editReply({ content: `Created OpenCode session in thread ${thread.id}.` });
  };
}

function requireOpencodeClient(client: unknown, projectPath: string): OpencodeSessionClient {
  if (!client) {
    throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode server is unavailable for this project.', { projectPath });
  }

  return client as OpencodeSessionClient;
}

function requireChannelConfig(context: InteractionContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
}

function requireGuildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a server.');
  }

  return interaction.guildId;
}

function requireThreadCreatableChannel(interaction: ChatInputCommandInteraction): ThreadCreatableChannel {
  const channel = interaction.channel as Partial<ThreadCreatableChannel> | null;
  if (!channel?.threads?.create) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a channel that supports threads.');
  }

  return channel as ThreadCreatableChannel;
}

function normalizeTitle(title: string | null, prompt: string): string {
  const base = title?.trim() || prompt.trim().slice(0, 50) || 'OpenCode session';
  return base.slice(0, 100);
}
