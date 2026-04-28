import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { ContextBuffer, createContextCommandHandler, type ContextCommandDependencies } from './context.js';

const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

function createInteraction(subcommand: string, strings: Record<string, string | null> = {}): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    channel: { parentId: 'channel-1' },
    options: { getSubcommand: vi.fn(() => subcommand), getString: vi.fn((name: string) => strings[name] ?? null) },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(buffer = new ContextBuffer(), resolveSafePath = vi.fn((root: string, file: string) => `${root}/${file}`)): ContextCommandDependencies {
  return { buffer, resolveSafePath };
}

describe('ContextBuffer', () => {
  it('enforces a maximum of 20 files per thread', () => {
    const buffer = new ContextBuffer();
    buffer.add('thread-1', Array.from({ length: 20 }, (_, index) => `/repo/file-${index}.ts`));

    expect(() => buffer.add('thread-1', ['/repo/overflow.ts'])).toThrowError(expect.objectContaining({ code: ErrorCode.CONTEXT_BUFFER_FULL }));
  });

  it('consumes buffered files as message handler context files and clears the buffer', async () => {
    const buffer = new ContextBuffer();
    buffer.add('thread-1', ['/repo/src/a.ts', '/repo/src/b.ts']);

    const files = await buffer.consume('thread-1');

    expect(files).toEqual([
      { path: '/repo/src/a.ts', url: 'file:///repo/src/a.ts', filename: 'a.ts' },
      { path: '/repo/src/b.ts', url: 'file:///repo/src/b.ts', filename: 'b.ts' },
    ]);
    expect(buffer.list('thread-1')).toEqual([]);
    await expect(buffer.consume('thread-1')).resolves.toEqual([]);
  });

  it('encodes buffered file paths as valid file URLs', async () => {
    const buffer = new ContextBuffer();
    buffer.add('thread-1', ['/repo/src/file #1.ts']);

    const files = await buffer.consume('thread-1');

    expect(files).toEqual([
      { path: '/repo/src/file #1.ts', url: 'file:///repo/src/file%20%231.ts', filename: 'file #1.ts' },
    ]);
  });
});

describe('createContextCommandHandler', () => {
  it('adds safe resolved files to the per-thread context buffer', async () => {
    const deps = createDeps();
    const interaction = createInteraction('add', { file1: 'src/a.ts', file2: 'src/b.ts' });

    await createContextCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.resolveSafePath).toHaveBeenCalledWith('/repo', 'src/a.ts');
    expect(deps.buffer.list('thread-1')).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Added to context:\n`/repo/src/a.ts`\n`/repo/src/b.ts`', ephemeral: true });
  });

  it('bounds long add confirmations with a truncation marker', async () => {
    const longPath = `/repo/${'a'.repeat(2100)}.ts`;
    const deps = createDeps(new ContextBuffer(), vi.fn(() => longPath));
    const interaction = createInteraction('add', { file1: 'long.ts' });

    await createContextCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const reply = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { content: string; ephemeral: boolean };
    expect(reply.content.length).toBeLessThanOrEqual(1800);
    expect(reply.content).toContain('... truncated');
  });

  it('throws a structured error when required file1 is missing', async () => {
    const deps = createDeps();
    const interaction = createInteraction('add');

    await expect(createContextCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
    expect(deps.resolveSafePath).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('lists buffered context files', async () => {
    const buffer = new ContextBuffer();
    buffer.add('thread-1', ['/repo/src/a.ts']);
    const interaction = createInteraction('list');

    await createContextCommandHandler(createDeps(buffer))(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Context buffer:\n`/repo/src/a.ts`', ephemeral: true });
  });

  it('bounds long list responses with a truncation marker', async () => {
    const buffer = new ContextBuffer();
    buffer.add('thread-1', [`/repo/${'b'.repeat(2100)}.ts`]);
    const interaction = createInteraction('list');

    await createContextCommandHandler(createDeps(buffer))(interaction, { correlationId: 'corr-1', channelConfig });

    const reply = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { content: string; ephemeral: boolean };
    expect(reply.content.length).toBeLessThanOrEqual(1800);
    expect(reply.content).toContain('... truncated');
  });

  it('clears buffered context files', async () => {
    const buffer = new ContextBuffer();
    buffer.add('thread-1', ['/repo/src/a.ts']);
    const interaction = createInteraction('clear');

    await createContextCommandHandler(createDeps(buffer))(interaction, { correlationId: 'corr-1', channelConfig });

    expect(buffer.list('thread-1')).toEqual([]);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Context buffer cleared.', ephemeral: true });
  });
});
