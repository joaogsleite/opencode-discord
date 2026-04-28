import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeCacheClient } from '../../opencode/cache.js';
import type { CacheManager } from '../../opencode/cache.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

const EMBED_TOTAL_LIMIT = 6000;
const EMBED_FIELD_LIMIT = 1024;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_COUNT_LIMIT = 25;
const MODEL_TRUNCATION_DESCRIPTION = 'Model list truncated to fit Discord embed limits.';

interface ModelStateManager {
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
}

/** Dependencies for the /model command handler. */
export interface ModelCommandDependencies {
  stateManager: ModelStateManager;
  serverManager: { ensureRunning(projectPath: string): Promise<unknown> };
  cacheManager: Pick<CacheManager, 'refresh' | 'getModels'>;
}

/**
 * Create a handler for model set/list subcommands.
 * @param deps - State, server, and cache dependencies.
 * @returns Discord command handler.
 */
export function createModelCommandHandler(deps: ModelCommandDependencies): CommandHandler {
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

    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unknown model subcommand: ${subcommand}`);
  };
}

async function handleSet(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: ModelCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  const threadId = requireThreadId(interaction);
  const model = interaction.options.getString('model', true);
  await interaction.deferReply();
  const client = await deps.serverManager.ensureRunning(channelConfig.projectPath) as OpencodeCacheClient;
  await deps.cacheManager.refresh(channelConfig.projectPath, client);

  if (!listModelIds(deps.cacheManager.getModels(channelConfig.projectPath)).includes(model)) {
    throw new BotError(ErrorCode.MODEL_NOT_FOUND, `Model \'${model}\' was not found.`, { model });
  }

  const session = requireSession(deps.stateManager.getSession(threadId), threadId);
  deps.stateManager.setSession(threadId, { ...session, model });
  await interaction.editReply({ content: `Model set to \`${model}\`.` });
}

async function handleList(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: ModelCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  await interaction.deferReply();
  const client = await deps.serverManager.ensureRunning(channelConfig.projectPath) as OpencodeCacheClient;
  await deps.cacheManager.refresh(channelConfig.projectPath, client);
  const providers = deps.cacheManager.getModels(channelConfig.projectPath);
  const embed = new EmbedBuilder().setTitle('Available Models').setColor(0x5865f2);
  let totalLength = 'Available Models'.length;
  let truncated = false;

  const providerCount = providers.filter((provider) => Boolean(getProviderId(provider))).length;

  for (const provider of providers) {
    const providerId = getProviderId(provider);
    if (providerId) {
      if ((embed.data.fields?.length ?? 0) >= EMBED_FIELD_COUNT_LIMIT) {
        truncated = true;
        break;
      }

      const name = truncateText(providerId, EMBED_FIELD_NAME_LIMIT);
      const value = formatModelField(getProviderModelIds(provider));
      const remainingProviders = providerCount - ((embed.data.fields?.length ?? 0) + 1);
      const reservedTruncationLength = remainingProviders > 0 ? MODEL_TRUNCATION_DESCRIPTION.length : 0;
      if (totalLength + name.length + value.length + reservedTruncationLength > EMBED_TOTAL_LIMIT) {
        truncated = true;
        break;
      }

      embed.addFields({ name, value, inline: false });
      totalLength += name.length + value.length;
    }
  }

  if (truncated) {
    embed.setDescription(MODEL_TRUNCATION_DESCRIPTION);
  } else if (embed.data.fields?.length === undefined) {
    embed.setDescription('No models available.');
  }

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

function listModelIds(providers: unknown[]): string[] {
  return providers.flatMap((provider) => getProviderModelIds(provider));
}

function getProviderId(provider: unknown): string | undefined {
  if (!provider || typeof provider !== 'object') {
    return undefined;
  }

  const record = provider as Record<string, unknown>;
  return typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : undefined;
}

function getProviderModelIds(provider: unknown): string[] {
  const providerId = getProviderId(provider);
  if (!provider || typeof provider !== 'object' || !providerId) {
    return [];
  }

  const record = provider as Record<string, unknown>;
  const models = Array.isArray(record.models) ? record.models : [];
  return models.map((model) => {
    if (typeof model === 'string') {
      return `${providerId}/${model}`;
    }

    if (model && typeof model === 'object') {
      const modelId = (model as Record<string, unknown>).id;
      return typeof modelId === 'string' ? `${providerId}/${modelId}` : undefined;
    }

    return undefined;
  }).filter((model): model is string => Boolean(model));
}

function formatModelField(models: string[]): string {
  if (models.length === 0) {
    return 'No models';
  }

  const lines: string[] = [];
  for (const model of models) {
    const next = `\`${model}\``;
    const suffix = `\n... truncated ${models.length - lines.length} models`;
    const candidate = [...lines, next].join('\n');
    if (candidate.length + suffix.length > EMBED_FIELD_LIMIT) {
      lines.push(`... truncated ${models.length - lines.length} models`);
      break;
    }
    lines.push(next);
  }

  return lines.join('\n').slice(0, EMBED_FIELD_LIMIT);
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 14)}... truncated`;
}
