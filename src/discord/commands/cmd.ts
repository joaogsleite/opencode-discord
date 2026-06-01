import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { checkAgentAllowed } from '../../utils/permissions.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface InteractionContext { correlationId: string; channelConfig?: ChannelConfig }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;
interface OpencodeCommand { name: string; description?: string; agent?: string; source?: string; template?: string; hints?: string[] }
interface CmdClient extends OpencodeSessionClient { command: { list(): Promise<unknown> } }
interface ThreadLike { id: string; send(content: unknown): Promise<unknown>; members: { add(userId: string): Promise<unknown> } }
interface ThreadCreatableChannel { threads: { create(options: { name: string; autoArchiveDuration: number; reason: string }): Promise<ThreadLike> } }

/** Dependencies for the /cmd command handler. */
export interface CmdCommandDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined; setSession(threadId: string, session: SessionState): void };
  serverManager: { ensureRunning(projectPath: string): Promise<unknown>; getClient(projectPath: string): unknown | undefined };
  sessionBridge: Pick<SessionBridge, 'createSession' | 'sendPrompt'>;
  listProjectCommands?: (projectPath: string) => Promise<string[]>;
  rememberThread?: (threadId: string, thread: ThreadLike) => void;
}

/**
 * Create a handler for listing and running OpenCode custom commands.
 * @param deps - State, server, and session dependencies.
 * @returns Discord command handler.
 */
export function createCmdCommandHandler(deps: CmdCommandDependencies): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'list') {
      await handleList(interaction, context, deps);
      return;
    }
    if (subcommand === 'run') {
      await handleRun(interaction, context, deps);
      return;
    }
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported cmd subcommand: ${subcommand}`);
  };
}

/**
 * Build command-name autocomplete choices.
 * @param commands - OpenCode command records.
 * @param focused - Current focused input.
 * @returns Discord autocomplete choices.
 */
export function getCmdAutocompleteChoices(commands: unknown[], projectCommands: string[], focused = ''): Array<{ name: string; value: string }> {
  return commands
    .map(normalizeCommand)
    .filter((command): command is OpencodeCommand => command !== undefined)
    .filter((command) => isProjectCommand(command, projectCommands))
    .filter((command) => command.name.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((command) => ({ name: command.name, value: command.name }));
}

async function handleList(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: CmdCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  await interaction.deferReply();
  const client = await ensureClient(deps, channelConfig.projectPath);
  await interaction.editReply(suppressLinkPreviews({ embeds: [formatCommandList(await listCommands(client, channelConfig.projectPath, deps))] }));
}

async function handleRun(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: CmdCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  const name = interaction.options.getString('name', true);
  const prompt = interaction.options.getString('prompt') ?? '';
  await interaction.deferReply();

  if (isThreadInteraction(interaction)) {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps, session.projectPath);
    await deps.sessionBridge.sendPrompt(interaction.channelId, { client, content: formatCommandPrompt(name, prompt) });
    await interaction.editReply(suppressLinkPreviews({ content: `Running OpenCode command \`${name}\`.` }));
    return;
  }

  const client = await ensureClient(deps, channelConfig.projectPath);
  const command = requireCommand(await listCommands(client, channelConfig.projectPath, deps), name);
  const agent = command.agent ?? channelConfig.defaultAgent ?? 'build';
  assertAgentAllowed(channelConfig, agent);
  const thread = await createThread(interaction, name);
  await thread.members.add(interaction.user.id);
  deps.rememberThread?.(thread.id, thread);
  await thread.send(suppressLinkPreviews(formatInitialCommand(name, prompt)));
  await deps.sessionBridge.createSession({
    client,
    threadId: thread.id,
    guildId: requireGuildId(interaction),
    channelId: interaction.channelId,
    projectPath: channelConfig.projectPath,
    agent,
    model: null,
    createdBy: interaction.user.id,
    title: normalizeTitle(name),
  });
  await deps.sessionBridge.sendPrompt(thread.id, { client, content: formatCommandPrompt(name, prompt) });
  await interaction.editReply(suppressLinkPreviews({ content: `Created OpenCode session in thread ${thread.id} and running command \`${name}\`.` }));
}

async function ensureClient(deps: CmdCommandDependencies, projectPath: string): Promise<CmdClient> {
  return await deps.serverManager.ensureRunning(projectPath) as CmdClient;
}

function requireClient(deps: CmdCommandDependencies, projectPath: string): CmdClient {
  const client = deps.serverManager.getClient(projectPath) as CmdClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

async function listCommands(client: CmdClient, projectPath: string, deps: Pick<CmdCommandDependencies, 'listProjectCommands'>): Promise<OpencodeCommand[]> {
  const response = await client.command.list();
  const data = isRecord(response) && Array.isArray(response.data) ? response.data : response;
  const projectCommands = await (deps.listProjectCommands ?? listProjectCommandFiles)(projectPath);
  return Array.isArray(data) ? data.map(normalizeCommand).filter((command): command is OpencodeCommand => command !== undefined).filter((command) => isProjectCommand(command, projectCommands)) : [];
}

function normalizeCommand(value: unknown): OpencodeCommand | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined;
  return {
    name: value.name,
    description: typeof value.description === 'string' ? value.description : undefined,
    agent: typeof value.agent === 'string' && value.agent.length > 0 ? value.agent : undefined,
    source: typeof value.source === 'string' ? value.source : undefined,
    template: typeof value.template === 'string' ? value.template : undefined,
    hints: Array.isArray(value.hints) ? value.hints.filter((hint): hint is string => typeof hint === 'string') : [],
  };
}

function isProjectCommand(command: OpencodeCommand, projectCommands: string[]): boolean {
  return command.source === 'command' && projectCommands.includes(command.name);
}

async function listProjectCommandFiles(projectPath: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectPath, '.opencode', 'commands'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
      .map((entry) => entry.name.slice(0, -3));
  } catch {
    return [];
  }
}

function requireCommand(commands: OpencodeCommand[], name: string): OpencodeCommand {
  const command = commands.find((item) => item.name === name);
  if (!command) throw new BotError(ErrorCode.DISCORD_API_ERROR, `OpenCode command not found: ${name}`, { command: name });
  return command;
}

function formatCommandList(commands: OpencodeCommand[]): EmbedBuilder {
  const description = boundDescription(commands.map((command) => `\`${command.name}\`${command.description ? ` - ${command.description}` : ''}`).join('\n') || 'No OpenCode commands available.');
  return new EmbedBuilder().setTitle('OpenCode Commands').setColor(0x5865f2).setDescription(description);
}

function boundDescription(value: string): string {
  const marker = '\n... truncated';
  return value.length <= 4096 ? value : `${value.slice(0, 4096 - marker.length)}${marker}`;
}

function requireChannelConfig(context: InteractionContext): ChannelConfig {
  if (!context.channelConfig) throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  return context.channelConfig;
}

function isThreadInteraction(interaction: ChatInputCommandInteraction): boolean {
  return (interaction.channel as { isThread?: () => boolean } | null)?.isThread?.() === true;
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: CmdCommandDependencies['stateManager']): SessionState {
  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  return session;
}

function assertAgentAllowed(channelConfig: ChannelConfig, agent: string): void {
  const allowed = checkAgentAllowed(channelConfig, agent);
  if (allowed !== true) {
    throw new BotError(ErrorCode[allowed.reason], allowed.reason === 'AGENT_SWITCH_DISABLED'
      ? 'Agent switching is disabled for this channel.'
      : `Agent '${agent}' is not allowed in this channel.`, { agent });
  }
}

async function createThread(interaction: ChatInputCommandInteraction, name: string): Promise<ThreadLike> {
  const channel = interaction.channel as Partial<ThreadCreatableChannel> | null;
  if (!channel?.threads?.create) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only create sessions in a channel that supports threads.');
  return await channel.threads.create({ name: normalizeTitle(name), autoArchiveDuration: 1440, reason: 'OpenCode command session' });
}

function normalizeTitle(name: string): string {
  return name.trim().slice(0, 100) || 'OpenCode command';
}

function requireGuildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a server.');
  return interaction.guildId;
}

function formatInitialCommand(name: string, prompt: string): string {
  return `> **/cmd run ${name}:**\n${prompt.split('\n').map((line) => `> ${line}`).join('\n')}`;
}

function formatCommandPrompt(name: string, prompt: string): string {
  return prompt ? `/${name} ${prompt}` : `/${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
