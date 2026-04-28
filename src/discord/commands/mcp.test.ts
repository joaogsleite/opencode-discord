import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createMcpCommandHandler, getMcpAutocompleteChoices, type McpCommandDependencies } from './mcp.js';

const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

function createInteraction(subcommand: string, name: string | null = null): ChatInputCommandInteraction {
  return {
    options: { getSubcommand: vi.fn(() => subcommand), getString: vi.fn(() => name) },
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(status: Record<string, unknown> = { filesystem: { status: 'connected' }, github: { status: 'failed', error: 'bad token' } }): McpCommandDependencies {
  const client = { mcp: { status: vi.fn(async () => status), connect: vi.fn(async () => true), disconnect: vi.fn(async () => true) } };
  return { serverManager: { ensureRunning: vi.fn(async () => client) }, cacheManager: { getMcpStatus: vi.fn(() => status), refresh: vi.fn(async () => undefined) } };
}

describe('createMcpCommandHandler', () => {
  it('lists MCP server statuses in an embed', async () => {
    const deps = createDeps();
    const interaction = createInteraction('list');

    await createMcpCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const client = await deps.serverManager.ensureRunning('/repo') as { mcp: { status: ReturnType<typeof vi.fn> } };
    expect(client.mcp.status).toHaveBeenCalledWith();
    expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: 'MCP Servers', description: expect.stringContaining('filesystem') }) })] });
  });

  it('reconnects all MCP servers when no name is provided', async () => {
    const deps = createDeps({ filesystem: { status: 'disabled' }, github: { status: 'connected' } });
    const interaction = createInteraction('reconnect');

    await createMcpCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const client = await deps.serverManager.ensureRunning('/repo') as { mcp: { connect: ReturnType<typeof vi.fn> } };
    expect(client.mcp.connect).toHaveBeenCalledWith({ name: 'filesystem' });
    expect(client.mcp.connect).toHaveBeenCalledWith({ name: 'github' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('filesystem: reconnected') });
  });

  it('bounds reconnect-all output with a truncation marker', async () => {
    const status = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`mcp-${index}-${'x'.repeat(20)}`, { status: 'disabled' }]));
    const deps = createDeps(status);
    const interaction = createInteraction('reconnect');

    await createMcpCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const reply = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { content: string };
    expect(reply.content.length).toBeLessThanOrEqual(1800);
    expect(reply.content).toContain('... truncated');
  });

  it('reports reconnect success when cache refresh fails', async () => {
    const deps = createDeps({ filesystem: { status: 'disabled' } });
    deps.cacheManager.refresh = vi.fn(async () => { throw new Error('cache failed'); });
    const interaction = createInteraction('reconnect', 'filesystem');

    await createMcpCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'filesystem: reconnected' });
  });

  it('disconnects a named MCP server', async () => {
    const deps = createDeps();
    const interaction = createInteraction('disconnect', 'filesystem');

    await createMcpCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const client = await deps.serverManager.ensureRunning('/repo') as { mcp: { disconnect: ReturnType<typeof vi.fn> } };
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ name: 'filesystem' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Disconnected MCP server `filesystem`.' });
  });

  it('reports disconnect success when cache refresh fails', async () => {
    const deps = createDeps();
    deps.cacheManager.refresh = vi.fn(async () => { throw new Error('cache failed'); });
    const interaction = createInteraction('disconnect', 'filesystem');

    await createMcpCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Disconnected MCP server `filesystem`.' });
  });

  it('throws a structured error when disconnect reports false', async () => {
    const client = { mcp: { status: vi.fn(async () => ({})), connect: vi.fn(async () => true), disconnect: vi.fn(async () => false) } };
    const deps = createDeps();
    deps.serverManager.ensureRunning = vi.fn(async () => client);

    await expect(createMcpCommandHandler(deps)(createInteraction('disconnect', 'missing'), { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.MCP_NOT_FOUND,
    });
  });

  it('builds autocomplete choices from cached MCP status keys', () => {
    expect(getMcpAutocompleteChoices({ filesystem: {}, github: {} }, 'git')).toEqual([{ name: 'github', value: 'github' }]);
  });
});
