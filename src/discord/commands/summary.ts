import type { ChatInputCommandInteraction } from 'discord.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { splitMessage as defaultSplitMessage } from '../../utils/formatter.js';

interface CommandContext { correlationId: string }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface SummaryClient { session: { summarize(options: { sessionID: string; providerID?: string; modelID?: string }): Promise<unknown> } }

/** Dependencies for the /summary command handler. */
export interface SummaryCommandDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined };
  serverManager: { getClient(projectPath: string): unknown | undefined };
  splitMessage?: (text: string) => string[];
}

/**
 * Create a handler for summarizing the active session.
 * @param deps - State and server dependencies.
 * @returns Discord command handler.
 */
export function createSummaryCommandHandler(deps: SummaryCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps.serverManager, session.projectPath);
    const model = parseModel(interaction.options.getString('model') ?? session.model);
    await interaction.deferReply();
    const summary = extractText(await client.session.summarize({ sessionID: session.sessionId, ...model }));
    const chunks = (deps.splitMessage ?? defaultSplitMessage)(summary || 'No summary returned.');
    await interaction.editReply({ content: chunks[0] ?? 'No summary returned.' });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk });
    }
  };
}

function parseModel(model: string | null): { providerID?: string; modelID?: string } {
  if (!model) return {};
  const [providerID, ...rest] = model.split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) throw new BotError(ErrorCode.MODEL_NOT_FOUND, `Invalid model: ${model}`, { model });
  return { providerID, modelID };
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: SummaryCommandDependencies['stateManager']): SessionState {
  if (!((interaction.channel as { parentId?: string | null } | null)?.parentId)) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Summary can only be used in a session thread.');
  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  return session;
}

function requireClient(serverManager: SummaryCommandDependencies['serverManager'], projectPath: string): SummaryClient {
  const client = serverManager.getClient(projectPath) as SummaryClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.data === 'string') return value.data;
  if (isRecord(value) && typeof value.summary === 'string') return value.summary;
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
