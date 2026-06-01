import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createCmdCommandHandler, getCmdAutocompleteChoices, type CmdCommandDependencies } from './cmd.js';

const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo', allowAgentSwitch: true, allowedAgents: ['build', 'review'] };
const session: SessionState = {
  sessionId: 'session-1',
  guildId: 'guild-1',
  channelId: 'channel-1',
  projectPath: '/repo',
  agent: 'build',
  model: null,
  createdBy: 'user-1',
  createdAt: 1000,
  lastActivityAt: 1000,
  status: 'active',
};

function createInteraction(subcommand: string, strings: Record<string, string> = {}, channel: unknown = { parentId: 'channel-1', isThread: () => true }): ChatInputCommandInteraction {
  return {
    channelId: channel && typeof channel === 'object' && 'parentId' in channel ? 'thread-1' : 'channel-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    channel,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string, required?: boolean) => {
        const value = strings[name] ?? null;
        if (required && value === null) throw new Error(`Missing ${name}`);
        return value;
      }),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(commands: unknown[] = [{ name: 'review', description: 'Review code', agent: 'review', source: 'command', template: '', hints: [] }], projectCommands = ['review']): CmdCommandDependencies {
  const client = {
    command: { list: vi.fn(async () => commands) },
    session: { create: vi.fn(async () => ({ id: 'session-new' })), command: vi.fn(async () => ({})) },
  };
  return {
    stateManager: { getSession: vi.fn(() => session), setSession: vi.fn() },
    serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(() => client) },
    sessionBridge: {
      createSession: vi.fn(async () => ({ ...session, sessionId: 'session-new', agent: 'review' })),
      sendPrompt: vi.fn(async () => undefined),
    },
    listProjectCommands: vi.fn(async () => projectCommands),
    rememberThread: vi.fn(),
  };
}

describe('createCmdCommandHandler', () => {
  it('lists OpenCode commands in an embed', async () => {
    const deps = createDeps([
      { name: 'review', description: 'Review code', agent: 'review', source: 'command', template: '', hints: [] },
      { name: 'init', description: 'Global command', source: 'command', template: '', hints: [] },
      { name: 'github-issue', description: 'MCP command', source: 'mcp', template: '', hints: [] },
      { name: 'brainstorming', description: 'Skill command', source: 'skill', template: '', hints: [] },
    ], ['review']);
    const interaction = createInteraction('list', {}, null);

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: 'OpenCode Commands', description: expect.stringContaining('review') }) })] }));
    expect(interaction.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ description: expect.stringContaining('init') }) })] }));
    expect(interaction.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ description: expect.stringContaining('github-issue') }) })] }));
    expect(interaction.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ description: expect.stringContaining('brainstorming') }) })] }));
  });

  it('sends a slash-command prompt in an active session thread', async () => {
    const deps = createDeps();
    const interaction = createInteraction('run', { name: 'review', prompt: 'check this' });

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const client = deps.serverManager.getClient('/repo');
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', { client, content: '/review check this' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Running OpenCode command `review`.' });
  });

  it('sends only the slash command when prompt is omitted', async () => {
    const deps = createDeps();
    const interaction = createInteraction('run', { name: 'review' });

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const client = deps.serverManager.getClient('/repo');
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', { client, content: '/review' });
  });

  it('creates a channel session with the selected command agent before running', async () => {
    const deps = createDeps();
    const thread = { id: 'thread-new', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { parentId: 'category-1', isThread: vi.fn(() => false), threads: { create: vi.fn(async () => thread) } };
    const interaction = createInteraction('run', { name: 'review', prompt: 'check this' }, channel);

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-new', agent: 'review', title: 'review' }));
    expect(channel.threads.create).toHaveBeenCalledWith({ name: 'review', autoArchiveDuration: 1440, reason: 'OpenCode command session' });
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-new', { client: deps.serverManager.getClient('/repo'), content: '/review check this' });
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('/cmd run review'));
  });

  it('falls back to the channel default agent when the command has no agent', async () => {
    const deps = createDeps([{ name: 'docs', description: 'Write docs', source: 'command', template: '', hints: [] }], ['docs']);
    const thread = { id: 'thread-new', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const interaction = createInteraction('run', { name: 'docs', prompt: 'write docs' }, { threads: { create: vi.fn(async () => thread) } });

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { ...channelConfig, defaultAgent: 'build' } });

    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'build' }));
  });

  it('rejects a command agent blocked by channel settings', async () => {
    const deps = createDeps([{ name: 'audit', agent: 'security', source: 'command', template: '', hints: [] }], ['audit']);
    const interaction = createInteraction('run', { name: 'audit', prompt: 'scan' }, { threads: { create: vi.fn() } });

    await expect(createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_ALLOWED });
  });

  it('rejects source command entries that are not project command files', async () => {
    const deps = createDeps([{ name: 'init', source: 'command', template: '', hints: [] }], ['review']);
    const interaction = createInteraction('run', { name: 'init', prompt: 'start' }, { threads: { create: vi.fn() } });

    await expect(createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({ code: ErrorCode.DISCORD_API_ERROR });
  });

  it('builds autocomplete choices from project custom command names only', () => {
    expect(getCmdAutocompleteChoices([
      { name: 'review', source: 'command' },
      { name: 'review-global', source: 'command' },
      { name: 'review-skill', source: 'skill' },
      { name: 'review-mcp', source: 'mcp' },
      { name: 'docs', source: 'command' },
    ], ['review'], 'rev')).toEqual([{ name: 'review', value: 'review' }]);
  });
});
