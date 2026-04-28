import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

interface EndStateManager {
  getSession(threadId: string): SessionState | undefined;
  removeSession(threadId: string): void;
  clearQueue(threadId: string): void;
}

interface ArchivableThread {
  setArchived(archived: boolean): Promise<unknown>;
}

interface AttachmentCleanup {
  cleanupSession(threadId: string, session: SessionState): Promise<void>;
}

/** Dependencies for the /end command handler. */
export interface EndCommandDependencies {
  stateManager: EndStateManager;
  serverManager: { getClient(projectPath: string): unknown };
  sessionBridge: Pick<SessionBridge, 'abortSession'>;
  attachmentCleanup?: AttachmentCleanup;
}

/**
 * Create a handler for ending an active session thread.
 * @param deps - State, server, and session bridge dependencies.
 * @returns Discord command handler.
 */
export function createEndCommandHandler(deps: EndCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const threadId = requireThreadId(interaction);
    const session = requireSession(deps.stateManager.getSession(threadId), threadId);
    const client = deps.serverManager.getClient(session.projectPath) as OpencodeSessionClient | undefined;
    await interaction.deferReply();

    if (client) {
      await deps.sessionBridge.abortSession(threadId, client);
    }

    deps.stateManager.clearQueue(threadId);
    try {
      await deps.attachmentCleanup?.cleanupSession(threadId, session);
    } catch {
      // Attachment cleanup is best-effort; ending the session must still complete.
    }
    deps.stateManager.removeSession(threadId);
    await interaction.editReply({ content: `Session \`${session.sessionId}\` ended.` });
    await (interaction.channel as ArchivableThread).setArchived(true);
  };
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
