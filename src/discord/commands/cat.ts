import * as fs from 'node:fs';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { inferLanguage, resolveSafePath } from '../../utils/filesystem.js';

interface CommandContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;

const MAX_BODY_LENGTH = 1800;

/** Dependencies for the /cat command handler. */
export interface CatCommandDependencies {
  resolveSafePath(projectRoot: string, relativePath: string): string;
  readFile(filePath: string): Promise<string>;
  inferLanguage(filePath: string): string;
}

const defaultDeps: CatCommandDependencies = {
  resolveSafePath,
  readFile: async (filePath) => fs.promises.readFile(filePath, 'utf-8'),
  inferLanguage,
};

/**
 * Create a handler for showing project file contents.
 * @param deps - Filesystem dependencies.
 * @returns Discord command handler.
 */
export function createCatCommandHandler(deps: CatCommandDependencies = defaultDeps): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const file = interaction.options.getString('file', true);
    const filePath = deps.resolveSafePath(channelConfig.projectPath, file);
    let content: string;
    try {
      content = await deps.readFile(filePath);
    } catch (error) {
      throw new BotError(ErrorCode.FILE_NOT_FOUND, `File not found: ${file}`, { file, cause: getErrorMessage(error) });
    }
    const ranged = applyLineRange(content, interaction.options.getInteger('start'), interaction.options.getInteger('end'));
    const language = deps.inferLanguage(filePath);

    await interaction.reply({ content: formatCodeBlock(language, ranged) });
  };
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
}

function applyLineRange(content: string, start: number | null, end: number | null): string {
  if (start === null && end === null) {
    return content;
  }

  const lines = content.split('\n');
  const startIndex = Math.max((start ?? 1) - 1, 0);
  const endIndex = end ?? lines.length;
  return lines.slice(startIndex, endIndex).join('\n');
}

function formatCodeBlock(language: string, content: string): string {
  let body = content;
  if (body.length > MAX_BODY_LENGTH) {
    body = `${body.slice(0, MAX_BODY_LENGTH)}\n... truncated`;
  }

  return `\`\`\`${language}\n${body}\n\`\`\``;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
