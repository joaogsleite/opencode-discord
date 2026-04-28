import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { listDirectory, resolveSafePath } from '../../utils/filesystem.js';

interface CommandContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
const MAX_MESSAGE_LENGTH = 2000;

/** Dependencies for the /ls command handler. */
export interface LsCommandDependencies {
  resolveSafePath(projectRoot: string, relativePath: string): string;
  listDirectory(dirPath: string): Promise<string[]>;
}

const defaultDeps: LsCommandDependencies = { resolveSafePath, listDirectory };

/**
 * Create a handler for listing project files.
 * @param deps - Filesystem dependencies.
 * @returns Discord command handler.
 */
export function createLsCommandHandler(deps: LsCommandDependencies = defaultDeps): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const requestedPath = interaction.options.getString('path') ?? '.';
    const dirPath = deps.resolveSafePath(channelConfig.projectPath, requestedPath);
    let entries: string[];
    try {
      entries = await deps.listDirectory(dirPath);
    } catch (error) {
      throw new BotError(ErrorCode.FILE_NOT_FOUND, `Path not found: ${requestedPath}`, { path: requestedPath, cause: getErrorMessage(error) });
    }

    await interaction.reply({ content: formatListing(entries) });
  };
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
}

function formatListing(entries: string[]): string {
  return formatCodeBlock(entries.join('\n') || 'Empty directory');
}

function formatCodeBlock(content: string): string {
  const prefix = '```\n';
  const suffix = '\n```';
  const marker = '\n... truncated';
  const maxBodyLength = MAX_MESSAGE_LENGTH - prefix.length - suffix.length;
  let body = content;

  if (body.length > maxBodyLength) {
    body = body.slice(0, maxBodyLength - marker.length) + marker;
  }

  return `${prefix}${body}${suffix}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
