import * as fs from 'node:fs';
import * as path from 'node:path';
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { resolveSafePath } from '../../utils/filesystem.js';

interface CommandContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;

/** Dependencies for the /download command handler. */
export interface DownloadCommandDependencies {
  resolveSafePath(projectRoot: string, relativePath: string): string;
  verifyReadable(filePath: string): Promise<{ isFile: boolean }>;
  createAttachment(filePath: string, name: string): unknown;
}

const defaultDeps: DownloadCommandDependencies = {
  resolveSafePath,
  verifyReadable: async (filePath) => {
    await fs.promises.access(filePath, fs.constants.R_OK);
    const stat = await fs.promises.stat(filePath);
    return { isFile: stat.isFile() };
  },
  createAttachment: (filePath, name) => new AttachmentBuilder(filePath, { name }),
};

/**
 * Create a handler for sending a project file as an attachment.
 * @param deps - Filesystem and Discord attachment dependencies.
 * @returns Discord command handler.
 */
export function createDownloadCommandHandler(deps: DownloadCommandDependencies = defaultDeps): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const file = interaction.options.getString('file', true);
    const filePath = deps.resolveSafePath(channelConfig.projectPath, file);
    try {
      const readable = await deps.verifyReadable(filePath);
      if (!readable.isFile) {
        throw new BotError(ErrorCode.FILE_NOT_FOUND, `File not found: ${file}`, { file, cause: 'Path is not a file' });
      }
    } catch (error) {
      if (error instanceof BotError) {
        throw error;
      }
      throw new BotError(ErrorCode.FILE_NOT_FOUND, `File not found: ${file}`, { file, cause: getErrorMessage(error) });
    }
    let attachment: AttachmentBuilder;
    try {
      attachment = deps.createAttachment(filePath, path.basename(file)) as AttachmentBuilder;
    } catch (error) {
      throw new BotError(ErrorCode.FILE_NOT_FOUND, `File not found: ${file}`, { file, cause: getErrorMessage(error) });
    }

    await interaction.reply({ files: [attachment] });
  };
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
