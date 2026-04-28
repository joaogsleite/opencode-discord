import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeCacheClient } from '../../opencode/cache.js';
import type { CacheManager } from '../../opencode/cache.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { checkAgentAllowed } from '../../utils/permissions.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

const EMBED_DESCRIPTION_LIMIT = 4096;

interface AgentStateManager {
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
}

/** Dependencies for the /agent command handler. */
export interface AgentCommandDependencies {
  stateManager: AgentStateManager;
  serverManager: { ensureRunning(projectPath: string): Promise<unknown> };
  cacheManager: Pick<CacheManager, 'refresh' | 'getAgents'>;
}

/**
 * Create a handler for agent set/list subcommands.
 * @param deps - State, server, and cache dependencies.
 * @returns Discord command handler.
 */
export function createAgentCommandHandler(deps: AgentCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction, context: InteractionContext): Promise<void> => {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'set') {
      await handleSet(interaction, context, deps);
      return;
    }

    if (subcommand === 'list') {
      await handleList(interaction, context, deps);
      return;
    }

    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unknown agent subcommand: ${subcommand}`);
  };
}

async function handleSet(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: AgentCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  const threadId = requireThreadId(interaction);
  const agent = interaction.options.getString('agent', true);
  const allowed = checkAgentAllowed(channelConfig, agent);

  if (allowed !== true) {
    throw new BotError(ErrorCode[allowed.reason], allowed.reason === 'AGENT_SWITCH_DISABLED'
      ? 'Agent switching is disabled for this channel.'
      : `Agent \'${agent}\' is not allowed in this channel.`, { agent });
  }

  const session = requireSession(deps.stateManager.getSession(threadId), threadId);
  deps.stateManager.setSession(threadId, { ...session, agent });
  await interaction.reply({ content: `Agent set to \`${agent}\`.` });
}

async function handleList(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: AgentCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  await interaction.deferReply();
  const client = await deps.serverManager.ensureRunning(channelConfig.projectPath) as OpencodeCacheClient;
  await deps.cacheManager.refresh(channelConfig.projectPath, client);
  const agents = deps.cacheManager.getAgents(channelConfig.projectPath)
    .map(getName)
    .filter((name): name is string => Boolean(name))
    .filter((name) => !channelConfig.allowedAgents?.length || channelConfig.allowedAgents.includes(name));
  const embed = new EmbedBuilder()
    .setTitle('Available Agents')
    .setColor(0x5865f2)
    .setDescription(agents.length > 0 ? formatAgentList(agents) : 'No agents available.');

  await interaction.editReply({ embeds: [embed] });
}

function requireChannelConfig(context: InteractionContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
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

function getName(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : undefined;
  }

  return undefined;
}

function formatAgentList(agents: string[]): string {
  const lines: string[] = [];

  for (const agent of agents) {
    const next = `\`${agent}\``;
    const suffix = `\n... truncated ${agents.length - lines.length} agents`;
    const candidate = [...lines, next].join('\n');
    if (candidate.length + suffix.length > EMBED_DESCRIPTION_LIMIT) {
      lines.push(`... truncated ${agents.length - lines.length} agents`);
      break;
    }
    lines.push(next);
  }

  return lines.join('\n').slice(0, EMBED_DESCRIPTION_LIMIT);
}
