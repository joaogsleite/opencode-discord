import type { ChatInputCommandInteraction } from 'discord.js';
import type { QueueEntry } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface CommandContext {
  correlationId: string;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
const MAX_MESSAGE_LENGTH = 2000;

interface QueueStateManager {
  getQueue(threadId: string): QueueEntry[];
  clearQueue(threadId: string): void;
  save?(): void;
}

/** Dependencies for the /queue command handler. */
export interface QueueCommandDependencies {
  stateManager: QueueStateManager;
}

/**
 * Create a handler for listing and clearing thread message queues.
 * @param deps - State manager dependency.
 * @returns Discord command handler.
 */
export function createQueueCommandHandler(deps: QueueCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const threadId = requireThreadId(interaction);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const queue = deps.stateManager.getQueue(threadId);
      await interaction.reply({ content: formatQueue(queue) });
      return;
    }

    if (subcommand === 'clear') {
      deps.stateManager.clearQueue(threadId);
      deps.stateManager.save?.();
      await interaction.reply({ content: 'Queue cleared.' });
      return;
    }

    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported queue subcommand: ${subcommand}`);
  };
}

function requireThreadId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel as { parentId?: string | null } | null;
  if (!channel?.parentId) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Queue commands can only be used in a session thread.');
  }

  return interaction.channelId;
}

function formatQueue(queue: QueueEntry[]): string {
  if (queue.length === 0) {
    return 'Queue empty';
  }

  const lines = queue.map((entry, index) => `${index + 1}. <@${entry.userId}>: ${preview(entry.content)}`);
  return truncateLines(lines);
}

function preview(content: string): string {
  return content.length > 80 ? `${content.slice(0, 77)}...` : content;
}

function truncateLines(lines: string[]): string {
  const marker = '... truncated';
  const output: string[] = [];

  for (const line of lines) {
    const candidate = [...output, line].join('\n');
    if (candidate.length + marker.length + 1 > MAX_MESSAGE_LENGTH) {
      output.push(marker);
      break;
    }
    output.push(line);
  }

  return output.join('\n');
}
