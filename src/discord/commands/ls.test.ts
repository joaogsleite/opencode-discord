import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createLsCommandHandler, type LsCommandDependencies } from './ls.js';

function createInteraction(path: string | null = null): ChatInputCommandInteraction {
  return {
    options: {
      getString: vi.fn((name: string) => name === 'path' ? path : null),
    },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<LsCommandDependencies> = {}): LsCommandDependencies {
  return {
    resolveSafePath: vi.fn(() => '/repo/src'),
    listDirectory: vi.fn(async () => ['commands/', 'index.ts']),
    ...overrides,
  };
}

describe('createLsCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('resolves the requested path and replies with a directory listing code block', async () => {
    const deps = createDeps();
    const interaction = createInteraction('src');

    await createLsCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.resolveSafePath).toHaveBeenCalledWith('/repo', 'src');
    expect(deps.listDirectory).toHaveBeenCalledWith('/repo/src');
    expect(interaction.reply).toHaveBeenCalledWith({ content: '```\ncommands/\nindex.ts\n```' });
  });

  it('maps directory listing failures to FILE_NOT_FOUND', async () => {
    const deps = createDeps({ listDirectory: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const interaction = createInteraction('missing');

    await expect(createLsCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
  });

  it('truncates large directory listings to stay within Discord limits', async () => {
    const entries = Array.from({ length: 500 }, (_, index) => `file-${index.toString().padStart(3, '0')}.txt`);
    const deps = createDeps({ listDirectory: vi.fn(async () => entries) });
    const interaction = createInteraction();

    await createLsCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const reply = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { content: string };
    expect(reply.content.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain('truncated');
  });
});
