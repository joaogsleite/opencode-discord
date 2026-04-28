import type { ChatInputCommandInteraction } from 'discord.js';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { resolveSafePath as defaultResolveSafePath } from '../../utils/filesystem.js';

interface CommandContext { correlationId: string; channelConfig?: ChannelConfig }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface ContextFile { path: string; url: string; mime?: string; filename?: string }
const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_REPLY_LENGTH = 1800;

/** In-memory per-thread context file buffer. */
export class ContextBuffer {
  private readonly filesByThread = new Map<string, string[]>();

  /**
   * Add files to a thread buffer.
   * @param threadId - Discord thread ID.
   * @param files - Absolute resolved files.
   * @returns Current files in the buffer.
   */
  public add(threadId: string, files: string[]): string[] {
    const current = this.list(threadId);
    const next = [...new Set([...current, ...files])];
    if (next.length > MAX_CONTEXT_FILES) {
      throw new BotError(ErrorCode.CONTEXT_BUFFER_FULL, 'Context buffer can contain at most 20 files.', { threadId });
    }
    this.filesByThread.set(threadId, next);
    return next;
  }

  /**
   * List files buffered for a thread.
   * @param threadId - Discord thread ID.
   * @returns Buffered files.
   */
  public list(threadId: string): string[] {
    return [...(this.filesByThread.get(threadId) ?? [])];
  }

  /**
   * Clear files buffered for a thread.
   * @param threadId - Discord thread ID.
   * @returns Nothing.
   */
  public clear(threadId: string): void {
    this.filesByThread.delete(threadId);
  }

  /**
   * Consume buffered files for the next message prompt.
   * @param threadId - Discord thread ID.
   * @returns Context file metadata for the message handler.
   */
  public async consume(threadId: string): Promise<ContextFile[]> {
    const files = this.list(threadId);
    this.clear(threadId);
    return files.map((path) => ({ path, url: pathToFileURL(path).href, filename: basename(path) }));
  }
}

/** Dependencies for the /context command handler. */
export interface ContextCommandDependencies {
  buffer: ContextBuffer;
  resolveSafePath?: (projectRoot: string, relativePath: string) => string;
}

/**
 * Create a handler for managing the per-thread context buffer.
 * @param deps - Context buffer and path resolver dependencies.
 * @returns Discord command handler.
 */
export function createContextCommandHandler(deps: ContextCommandDependencies): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const threadId = requireThreadId(interaction);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const resolver = deps.resolveSafePath ?? defaultResolveSafePath;
      const file1 = interaction.options.getString('file1');
      if (!file1) {
        throw new BotError(ErrorCode.FILE_NOT_FOUND, 'Context add requires file1.');
      }

      const files = [file1, ...['file2', 'file3', 'file4', 'file5']
        .map((name) => interaction.options.getString(name))
        .filter((file): file is string => Boolean(file))]
        .map((file) => resolver(channelConfig.projectPath, file));
      deps.buffer.add(threadId, files);
      await interaction.reply({ content: boundedFileList('Added to context:', files), ephemeral: true });
      return;
    }

    if (subcommand === 'list') {
      const files = deps.buffer.list(threadId);
      await interaction.reply({ content: files.length ? boundedFileList('Context buffer:', files) : 'No files in context buffer.', ephemeral: true });
      return;
    }

    if (subcommand === 'clear') {
      deps.buffer.clear(threadId);
      await interaction.reply({ content: 'Context buffer cleared.', ephemeral: true });
      return;
    }

    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported context subcommand: ${subcommand}`);
  };
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  return context.channelConfig;
}

function requireThreadId(interaction: ChatInputCommandInteraction): string {
  if (!((interaction.channel as { parentId?: string | null } | null)?.parentId)) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Context can only be used in a session thread.');
  return interaction.channelId;
}

function boundedFileList(header: string, files: string[]): string {
  const marker = '\n... truncated';
  const full = `${header}\n${files.map((file) => `\`${file}\``).join('\n')}`;
  if (full.length <= MAX_CONTEXT_REPLY_LENGTH) return full;
  return `${full.slice(0, MAX_CONTEXT_REPLY_LENGTH - marker.length)}${marker}`;
}
