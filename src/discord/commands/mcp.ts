import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

interface CommandContext { correlationId: string; channelConfig?: ChannelConfig }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface McpClient { mcp: { status(): Promise<unknown>; connect(options: { name: string }): Promise<unknown>; disconnect(options: { name: string }): Promise<unknown> } }
const MAX_MCP_REPLY_LENGTH = 1800;

/** Dependencies for the /mcp command handler. */
export interface McpCommandDependencies {
  serverManager: { ensureRunning(projectPath: string): Promise<unknown> };
  cacheManager: { getMcpStatus(projectPath: string): Record<string, unknown>; refresh(projectPath: string, client: unknown): Promise<void> };
}

/**
 * Create a handler for MCP list, reconnect, and disconnect commands.
 * @param deps - Server and cache dependencies.
 * @returns Discord command handler.
 */
export function createMcpCommandHandler(deps: McpCommandDependencies): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const client = await deps.serverManager.ensureRunning(channelConfig.projectPath) as McpClient;
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply();

    if (subcommand === 'list') {
      const status = normalizeRecord(await client.mcp.status());
      await interaction.editReply({ embeds: [formatMcpStatus(status)] });
      return;
    }

    if (subcommand === 'reconnect') {
      const name = interaction.options.getString('name');
      const names = name ? [name] : Object.keys(normalizeRecord(await client.mcp.status()));
      const lines: string[] = [];
      for (const mcpName of names) {
        const ok = await client.mcp.connect({ name: mcpName });
        lines.push(`${mcpName}: ${ok === false ? 'failed' : 'reconnected'}`);
      }
      await refreshCacheBestEffort(deps, channelConfig.projectPath, client);
      await interaction.editReply({ content: boundReply(lines.join('\n') || 'No MCP servers found.') });
      return;
    }

    if (subcommand === 'disconnect') {
      const name = interaction.options.getString('name', true);
      const disconnected = await client.mcp.disconnect({ name });
      if (disconnected === false) {
        throw new BotError(ErrorCode.MCP_NOT_FOUND, `MCP server not found: ${name}`, { name });
      }
      await refreshCacheBestEffort(deps, channelConfig.projectPath, client);
      await interaction.editReply({ content: `Disconnected MCP server \`${name}\`.` });
      return;
    }

    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported MCP subcommand: ${subcommand}`);
  };
}

/**
 * Build MCP autocomplete choices from cached status names.
 * @param status - Cached MCP status record.
 * @param focused - Current focused input.
 * @returns Discord autocomplete choices.
 */
export function getMcpAutocompleteChoices(status: Record<string, unknown>, focused = ''): Array<{ name: string; value: string }> {
  return Object.keys(status).filter((name) => name.toLowerCase().includes(focused.toLowerCase())).slice(0, 25).map((name) => ({ name, value: name }));
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  return context.channelConfig;
}

function formatMcpStatus(status: Record<string, unknown>): EmbedBuilder {
  const description = Object.entries(status).map(([name, value]) => `${indicator(value)} **${name}** ${statusText(value)}`).join('\n') || 'No MCP servers configured.';
  return new EmbedBuilder().setTitle('MCP Servers').setColor(0x5865f2).setDescription(description.slice(0, 4000));
}

function indicator(value: unknown): string {
  const status = getStatus(value);
  if (status === 'connected') return '[connected]';
  if (status === 'failed') return '[failed]';
  if (status === 'needs_auth') return '[needs_auth]';
  return '[disabled]';
}

function statusText(value: unknown): string {
  const error = isRecord(value) && typeof value.error === 'string' ? `: ${value.error}` : '';
  return `${getStatus(value)}${error}`;
}

function getStatus(value: unknown): string {
  return isRecord(value) && typeof value.status === 'string' ? value.status : 'unknown';
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  const data = isRecord(value) && isRecord(value.data) ? value.data : value;
  return isRecord(data) ? data : {};
}

async function refreshCacheBestEffort(deps: McpCommandDependencies, projectPath: string, client: unknown): Promise<void> {
  try { await deps.cacheManager.refresh(projectPath, client); } catch { /* cache refresh should not block MCP commands */ }
}

function boundReply(content: string): string {
  const marker = '\n... truncated';
  if (content.length <= MAX_MCP_REPLY_LENGTH) return content;
  return `${content.slice(0, MAX_MCP_REPLY_LENGTH - marker.length)}${marker}`;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
