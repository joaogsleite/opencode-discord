import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { BotState, SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { createLogger, type Logger } from '../../utils/logger.js';

interface CommandContext { correlationId: string; channelConfig?: ChannelConfig }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface RestartClient { session?: { abort(options: { sessionID: string }): Promise<unknown> } }
interface ComponentInteractionLike { customId: string; user?: { id: string }; reply(options: unknown): Promise<unknown>; update(options: unknown): Promise<unknown> }
interface ComponentCollectorLike { on(event: 'collect', listener: (interaction: ComponentInteractionLike) => Promise<void>): void; on(event: 'end', listener: (collected: unknown, reason: string) => Promise<void>): void }
interface MessageWithCollector { createMessageComponentCollector(options: { time: number }): ComponentCollectorLike; edit(options: unknown): Promise<unknown> }
interface ThreadLike { send(content: string): Promise<unknown> }
const logger = createLogger('RestartCommand');

/** Dependencies for the /restart command handler. */
export interface RestartCommandDependencies {
  stateManager: { getState(): Pick<BotState, 'sessions'> };
  serverManager: { getClient(projectPath: string): unknown | undefined; shutdown(projectPath: string): Promise<void>; ensureRunning(projectPath: string): Promise<unknown> };
  streamHandler: { unsubscribe(threadId: string): void; subscribe(threadId: string, sessionId: string, client: unknown, dedupeSet?: Set<string>, projectPath?: string): Promise<void> | void };
  cacheManager: { refresh(projectPath: string, client: unknown): Promise<void> };
  getThread(threadId: string): ThreadLike | undefined;
  logger?: Pick<Logger, 'error'>;
}

/**
 * Create a handler for restarting an OpenCode server after button confirmation.
 * @param deps - State, server, stream, cache, and Discord thread dependencies.
 * @returns Discord command handler.
 */
export function createRestartCommandHandler(deps: RestartCommandDependencies): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const sessions = getActiveProjectSessions(deps.stateManager.getState().sessions, channelConfig.projectPath);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('restart-confirm').setLabel('Restart').setStyle(ButtonStyle.Danger),
    );
    const message = await interaction.reply({
      content: `This will restart the OpenCode server for ${channelConfig.projectPath}. All active sessions (${sessions.length}) will be interrupted.`,
      components: [row],
      fetchReply: true,
    });
    const collectorMessage = message as unknown as Partial<MessageWithCollector>;
    const collector = collectorMessage.createMessageComponentCollector?.({ time: 30_000 });
    let completed = false;

    collector?.on('collect', async (componentInteraction) => {
      if (componentInteraction.user?.id !== interaction.user.id) {
        await componentInteraction.reply({ content: 'Only the user who requested this restart can confirm it.', ephemeral: true });
        return;
      }
      if (componentInteraction.customId !== 'restart-confirm') return;
      try {
        await restartProject(deps, channelConfig.projectPath, sessions);
        completed = true;
        await componentInteraction.update({ content: `OpenCode server restarted for \`${channelConfig.projectPath}\`.`, components: [] });
      } catch (err) {
        completed = true;
        const activeLogger = deps.logger ?? logger;
        activeLogger.error('Restart confirmation failed', { correlationId: context.correlationId, projectPath: channelConfig.projectPath, err });
        await componentInteraction.update({ content: `Restart failed. *(ref: ${context.correlationId})*`, components: [] });
      }
    });

    collector?.on('end', async (_collected, reason) => {
      if (!completed && reason === 'time' && collectorMessage.edit) await collectorMessage.edit({ content: 'Restart confirmation expired.', components: [] });
    });
  };
}

async function restartProject(deps: RestartCommandDependencies, projectPath: string, sessions: Array<{ threadId: string; session: SessionState }>): Promise<void> {
  const oldClient = deps.serverManager.getClient(projectPath) as RestartClient | undefined;
  for (const { threadId, session } of sessions) {
    try { await oldClient?.session?.abort({ sessionID: session.sessionId }); } catch { /* best effort before restart */ }
    deps.streamHandler.unsubscribe(threadId);
  }

  await deps.serverManager.shutdown(projectPath);
  const client = await deps.serverManager.ensureRunning(projectPath);
  try { await deps.cacheManager.refresh(projectPath, client); } catch { /* cache refresh is best-effort after restart */ }

  for (const { threadId, session } of sessions) {
    await deps.streamHandler.subscribe(threadId, session.sessionId, client, new Set<string>(), projectPath);
    await deps.getThread(threadId)?.send('Server restarted. Session reconnected.');
  }
}

function getActiveProjectSessions(sessions: Record<string, SessionState>, projectPath: string): Array<{ threadId: string; session: SessionState }> {
  return Object.entries(sessions).filter(([, session]) => session.projectPath === projectPath && session.status === 'active').map(([threadId, session]) => ({ threadId, session }));
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  return context.channelConfig;
}
