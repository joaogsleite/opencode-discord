import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Interaction,
  InteractionReplyOptions,
} from 'discord.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { generateCorrelationId } from '../../utils/logger.js';
import { checkUserAllowed } from '../../utils/permissions.js';

/** Context passed to interaction sub-handlers. */
export interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

/**
 * Executes a chat input command interaction.
 * @param interaction - Discord chat input command interaction
 * @param context - Per-interaction context including correlation ID and channel config
 * @returns Nothing
 */
export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  context: InteractionContext,
) => Promise<void>;

/**
 * Resolves autocomplete choices for an interaction.
 * @param interaction - Discord autocomplete interaction
 * @param context - Per-interaction context including correlation ID and channel config
 * @returns Autocomplete choices to send to Discord
 */
export type AutocompleteHandler = (
  interaction: AutocompleteInteraction,
  context: InteractionContext,
) => Promise<ApplicationCommandOptionChoiceData[]>;

/** Options for the Discord interaction router. */
export interface InteractionHandlerOptions {
  configLoader: ConfigLoader;
  commandHandlers: Map<string, CommandHandler>;
  autocompleteHandler: AutocompleteHandler;
}

/**
 * Route supported Discord interactions to command or autocomplete handlers.
 * @param interaction - Incoming Discord interaction
 * @param options - Router dependencies and registered handlers
 * @returns Nothing
 */
export async function handleInteraction(
  interaction: Interaction,
  options: InteractionHandlerOptions,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleCommandInteraction(interaction, options);
    return;
  }

  if (interaction.isAutocomplete()) {
    await handleAutocompleteInteraction(interaction, options);
  }
}

async function handleCommandInteraction(
  interaction: ChatInputCommandInteraction,
  options: InteractionHandlerOptions,
): Promise<void> {
  const context = createContext(interaction, options.configLoader);

  try {
    if (context.channelConfig && !checkUserAllowed(context.channelConfig, interaction.user.id)) {
      throw new BotError(ErrorCode.PERMISSION_DENIED, 'You are not allowed to use this bot in this channel.');
    }

    const handler = options.commandHandlers.get(interaction.commandName);

    if (!handler) {
      throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unknown command: ${interaction.commandName}`);
    }

    await handler(interaction, context);
  } catch (err) {
    await sendError(interaction, err, context.correlationId);
  }
}

async function handleAutocompleteInteraction(
  interaction: AutocompleteInteraction,
  options: InteractionHandlerOptions,
): Promise<void> {
  const context = createContext(interaction, options.configLoader);

  try {
    const choices = await options.autocompleteHandler(interaction, context);
    await interaction.respond(choices.slice(0, 25));
  } catch {
    await interaction.respond([]);
  }
}

function createContext(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  configLoader: ConfigLoader,
): InteractionContext {
  const correlationId = generateCorrelationId(interaction.channelId ?? interaction.id);
  const channelConfig = interaction.guildId
    ? configLoader.getChannelConfig(interaction.guildId, interaction.channelId)
    : undefined;

  return { correlationId, channelConfig };
}

async function sendError(
  interaction: ChatInputCommandInteraction,
  err: unknown,
  correlationId: string,
): Promise<void> {
  const content = err instanceof BotError
    ? `**Error:** ${err.message} *(ref: ${correlationId})*`
    : `**Unexpected error** *(ref: ${correlationId})*`;
  const options: InteractionReplyOptions = { content, ephemeral: true };

  if (interaction.replied) {
    await interaction.followUp(options);
    return;
  }

  if (interaction.deferred) {
    await interaction.editReply({ content });
    return;
  }

  await interaction.reply(options);
}
