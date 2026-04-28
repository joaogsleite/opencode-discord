import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createGitCommandHandler, type GitCommandDependencies } from './git.js';

function createInteraction(options: {
  subcommand?: string;
  group?: string | null;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  replyResult?: unknown;
  userId?: string;
} = {}): ChatInputCommandInteraction {
  return {
    user: { id: options.userId ?? 'user-1' },
    options: {
      getSubcommand: vi.fn(() => options.subcommand ?? 'status'),
      getSubcommandGroup: vi.fn(() => options.group ?? null),
      getString: vi.fn((name: string) => options.strings?.[name] ?? null),
      getInteger: vi.fn((name: string) => options.integers?.[name] ?? null),
      getBoolean: vi.fn((name: string) => options.booleans?.[name] ?? null),
    },
    reply: vi.fn(async () => options.replyResult),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<GitCommandDependencies> = {}): GitCommandDependencies {
  return {
    execFile: vi.fn(async () => ({ stdout: ' M src/index.ts\n', stderr: '' })),
    ...overrides,
  };
}

describe('createGitCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('runs git status --short in the project directory and formats output', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ subcommand: 'status' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(deps.execFile).toHaveBeenCalledWith('git', ['status', '--short'], { cwd: '/repo' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```\n M src/index.ts\n```' });
  });

  it('refuses checkout when the worktree has uncommitted changes', async () => {
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => args[0] === 'status'
      ? { stdout: ' M src/index.ts\n', stderr: '' }
      : { stdout: '', stderr: '' }) });
    const interaction = createInteraction({ subcommand: 'checkout', strings: { branch: 'feature/x' } });

    await expect(createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.GIT_DIRTY,
    });
  });

  it('maps rejected checkout preflight git failures to DISCORD_API_ERROR BotError', async () => {
    const error = Object.assign(new Error('git failed'), { stderr: 'fatal: not a git repository' });
    const deps = createDeps({ execFile: vi.fn(async () => { throw error; }) });
    const interaction = createInteraction({ subcommand: 'checkout', strings: { branch: 'feature/x' } });

    await expect(createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    });
  });

  it('sends a destructive reset hard confirmation without executing reset immediately', async () => {
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn() })) };
    const deps = createDeps();
    const interaction = createInteraction({ subcommand: 'reset', strings: { target: 'hard' }, replyResult: message });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ fetchReply: true, components: expect.any(Array) }));
    expect(message.createMessageComponentCollector).toHaveBeenCalledWith({ time: 30_000 });
  });

  it('rejects reset hard confirmation clicks from other users without running reset', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const componentInteraction = {
      customId: 'git-reset-hard-confirm',
      user: { id: 'user-2' },
      reply: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    const interaction = createInteraction({ subcommand: 'reset', strings: { target: 'hard' }, replyResult: message, userId: 'user-1' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });
    await handlers.get('collect')?.(componentInteraction);

    expect(deps.execFile).not.toHaveBeenCalled();
    expect(componentInteraction.reply).toHaveBeenCalledWith({ content: 'Only the user who requested this reset can confirm it.', ephemeral: true });
    expect(componentInteraction.update).not.toHaveBeenCalled();
  });

  it('maps stash pop git failures to GIT_CONFLICT BotError', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: '', stderr: 'CONFLICT (content): merge conflict' })) });
    const interaction = createInteraction({ group: 'stash', subcommand: 'pop' });

    await expect(createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.GIT_CONFLICT,
    });
  });

  it('maps rejected stash pop conflicts from execFile to GIT_CONFLICT BotError', async () => {
    const error = Object.assign(new Error('git failed'), { stderr: 'CONFLICT (content): merge conflict' });
    const deps = createDeps({ execFile: vi.fn(async () => { throw error; }) });
    const interaction = createInteraction({ group: 'stash', subcommand: 'pop' });

    await expect(createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.GIT_CONFLICT,
    });
  });

  it('maps rejected git failures to DISCORD_API_ERROR BotError', async () => {
    const error = Object.assign(new Error('git failed'), { stderr: 'fatal: not a git repository' });
    const deps = createDeps({ execFile: vi.fn(async () => { throw error; }) });
    const interaction = createInteraction({ subcommand: 'status' });

    await expect(createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    });
  });

  it('reports no stashes when stash list output is empty', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: '', stderr: '' })) });
    const interaction = createInteraction({ group: 'stash', subcommand: 'list' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenCalledWith('git', ['stash', 'list'], { cwd: '/repo' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```\nNo stashes.\n```' });
  });
});
