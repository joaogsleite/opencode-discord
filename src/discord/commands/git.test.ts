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
    lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
    readFile: vi.fn(async () => ''),
    readlink: vi.fn(async () => ''),
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
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => args[0] === 'ls-files'
      ? { stdout: '', stderr: '' }
      : { stdout: 'diff --git a/file.ts b/file.ts\n', stderr: '' }) });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenCalledWith('git', ['diff'], { cwd: '/repo' });
    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/file.ts b/file.ts\n```' });
  });

  it('appends untracked files to default git diff output as new file additions', async () => {
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => {
      if (args[0] === 'diff') {
        return { stdout: 'diff --git a/file.ts b/file.ts\n', stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return { stdout: 'notes.md\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }), readFile: vi.fn(async () => 'first line\nsecond line\n') });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenNthCalledWith(1, 'git', ['diff'], { cwd: '/repo' });
    expect(deps.execFile).toHaveBeenNthCalledWith(2, 'git', ['ls-files', '--others', '--exclude-standard'], { cwd: '/repo' });
    expect(deps.readFile).toHaveBeenCalledWith('/repo/notes.md', 'utf8');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/file.ts b/file.ts\ndiff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n+first line\n+second line\n```' });
  });

  it('does not append untracked files to staged git diff output', async () => {
    const deps = createDeps({ execFile: vi.fn(async () => ({ stdout: 'diff --git a/file.ts b/file.ts\n', stderr: '' })) });
    const interaction = createInteraction({ subcommand: 'diff', strings: { target: 'staged' } });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenCalledTimes(1);
    expect(deps.execFile).toHaveBeenCalledWith('git', ['diff', '--cached'], { cwd: '/repo' });
  });

  it('shows a selected untracked file as a new file diff', async () => {
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => {
      if (args[0] === 'diff') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return { stdout: 'notes.md\n', stderr: '' };
      }
      return { stdout: 'draft\n', stderr: '' };
    }), readFile: vi.fn(async () => 'draft\n') });
    const interaction = createInteraction({ subcommand: 'diff', strings: { file: 'notes.md' } });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenNthCalledWith(1, 'git', ['diff', '--', 'notes.md'], { cwd: '/repo' });
    expect(deps.execFile).toHaveBeenNthCalledWith(2, 'git', ['ls-files', '--others', '--exclude-standard', '--', 'notes.md'], { cwd: '/repo' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n+draft\n```' });
  });

  it('shows an untracked symlink as link text without reading the target file', async () => {
    const deps = createDeps({
      execFile: vi.fn(async (_file, args) => args[0] === 'ls-files'
        ? { stdout: 'outside-link\n', stderr: '' }
        : { stdout: '', stderr: '' }),
      lstat: vi.fn(async () => ({ isSymbolicLink: () => true })),
      readlink: vi.fn(async () => '/etc/passwd'),
    });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.readlink).toHaveBeenCalledWith('/repo/outside-link');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/outside-link b/outside-link\nnew file mode 120000\n--- /dev/null\n+++ b/outside-link\n+/etc/passwd\n```' });
  });

  it('splits long git diff output across inline code block messages without truncating', async () => {
    const diff = `${'diff --git a/file.ts b/file.ts\n'.repeat(80)}final line`;
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => args[0] === 'ls-files'
      ? { stdout: '', stderr: '' }
      : { stdout: diff, stderr: '' }) });
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

  it('summarizes extremely long git diff output as a markdown file list including untracked files', async () => {
    const diff = 'a'.repeat(25_000);
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => {
      if (args.includes('--numstat')) {
        return { stdout: '12\t3\tsrc/index.ts\n0\t4\tsrc/git.ts\n', stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return { stdout: 'src/new.ts\n', stderr: '' };
      }
      return { stdout: diff, stderr: '' };
    }) });
    const interaction = createInteraction({ subcommand: 'diff' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenNthCalledWith(1, 'git', ['diff'], { cwd: '/repo' });
    expect(deps.execFile).toHaveBeenNthCalledWith(2, 'git', ['ls-files', '--others', '--exclude-standard'], { cwd: '/repo' });
    expect(deps.execFile).toHaveBeenNthCalledWith(3, 'git', ['diff', '--numstat'], { cwd: '/repo' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Diff is too large to display inline. Re-run `/git diff file:<path>` to inspect one file.\n\n- src/index.ts\n- src/git.ts\n- src/new.ts' });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('passes a file pathspec to git diff when file is provided', async () => {
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => args[0] === 'ls-files'
      ? { stdout: '', stderr: '' }
      : { stdout: 'diff --git a/src/index.ts b/src/index.ts\n', stderr: '' }) });
    const interaction = createInteraction({ subcommand: 'diff', strings: { file: 'src/index.ts' } });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.execFile).toHaveBeenCalledWith('git', ['diff', '--', 'src/index.ts'], { cwd: '/repo' });
  });

  it('keeps non-diff git output inline', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ subcommand: 'status' });

    await createGitCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```\n M src/index.ts\n```' });
  });

  it('escapes triple backticks inside git diff output code blocks', async () => {
    const deps = createDeps({ execFile: vi.fn(async (_file, args) => args[0] === 'ls-files'
      ? { stdout: '', stderr: '' }
      : { stdout: 'diff --git a/file.md b/file.md\n+```ts\n+inside\n+```\n', stderr: '' }) });
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
