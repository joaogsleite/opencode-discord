import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
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
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<GitCommandDependencies> = {}): GitCommandDependencies {
  return {
    execFile: vi.fn(async () => ({ stdout: ' M src/index.ts\n', stderr: '' })),
    createAttachment: vi.fn((content: string, name: string) => ({ content, name })),
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
      message: expect.stringContaining('fatal: not a git repository'),
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
    expect(componentInteraction.reply).toHaveBeenCalledWith({ content: 'Only the user who requested this reset can confirm it.', flags: MessageFlags.Ephemeral });
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
      message: expect.stringContaining('fatal: not a git repository'),
    });
  });

  it('reports no stashes when stash list output is empty', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: '', stderr: '' })) });
    const interaction = createInteraction({ group: 'stash', subcommand: 'list' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenCalledWith('git', ['stash', 'list'], { cwd: '/repo' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```\nNo stashes.\n```' });
  });

  it('sends git diff output as an inline code block', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: 'diff --git a/file.ts b/file.ts\n', stderr: '' })) });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenCalledWith('git', ['diff'], { cwd: '/repo' });
    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/file.ts b/file.ts\n```' });
  });

  it('splits long git diff output across inline code block messages without truncating', async () => {
    const diff = `${'diff --git a/file.ts b/file.ts\n'.repeat(80)}final line`;
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: diff, stderr: '' })) });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const firstContent = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { content: string };
    expect(interaction.followUp).toHaveBeenCalled();
    const followUpContent = vi.mocked(interaction.followUp).mock.calls[0]?.[0] as { content: string };
    expect(firstContent.content).toMatch(/^```diff\n/);
    expect(firstContent.content.length).toBeLessThanOrEqual(2000);
    expect(followUpContent.content).toMatch(/^```diff\n/);
    expect(followUpContent.content.length).toBeLessThanOrEqual(2000);
    expect(`${firstContent.content}\n${followUpContent.content}`).toContain('final line');
    expect(`${firstContent.content}\n${followUpContent.content}`).not.toContain('... truncated');
  });

  it('truncates extremely long git diff output after sending inline code blocks', async () => {
    const diff = 'a'.repeat(25_000);
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: diff, stderr: '' })) });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const sent = [
      vi.mocked(interaction.editReply).mock.calls[0]?.[0],
      ...vi.mocked(interaction.followUp).mock.calls.map((call) => call[0]),
    ] as Array<{ content: string }>;
    expect(sent.at(-1)?.content).toContain('... truncated');
    expect(sent.every((message) => message.content.length <= 2000)).toBe(true);
  });

  it('keeps non-diff git output inline', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ subcommand: 'status' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```\n M src/index.ts\n```' });
  });

  it('escapes triple backticks inside git diff output code blocks', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: 'diff --git a/file.md b/file.md\n+```ts\n+inside\n+```\n', stderr: '' })) });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/file.md b/file.md\n+`\u200b``ts\n+inside\n+`\u200b``\n```' });
  });

  it('escapes triple backticks inside non-diff git output code blocks', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: 'stash@{0}: ``` marker\n', stderr: '' })) });
    const interaction = createInteraction({ group: 'stash', subcommand: 'list' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```\nstash@{0}: `\u200b`` marker\n```' });
  });
});
