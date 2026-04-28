import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createCatCommandHandler, type CatCommandDependencies } from './cat.js';

function createInteraction(options: { file?: string; start?: number | null; end?: number | null } = {}): ChatInputCommandInteraction {
  return {
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === 'file') {
          return options.file ?? (required ? 'src/index.ts' : null);
        }
        return null;
      }),
      getInteger: vi.fn((name: string) => {
        if (name === 'start') {
          return options.start ?? null;
        }
        if (name === 'end') {
          return options.end ?? null;
        }
        return null;
      }),
    },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<CatCommandDependencies> = {}): CatCommandDependencies {
  return {
    resolveSafePath: vi.fn(() => '/repo/src/index.ts'),
    readFile: vi.fn(async () => 'line 1\nline 2\nline 3'),
    inferLanguage: vi.fn(() => 'typescript'),
    ...overrides,
  };
}

describe('createCatCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('reads a safe file path, applies line range, and replies with a fenced code block', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ file: 'src/index.ts', start: 2, end: 3 });

    await createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.resolveSafePath).toHaveBeenCalledWith('/repo', 'src/index.ts');
    expect(deps.readFile).toHaveBeenCalledWith('/repo/src/index.ts');
    expect(deps.inferLanguage).toHaveBeenCalledWith('/repo/src/index.ts');
    expect(interaction.reply).toHaveBeenCalledWith({ content: '```typescript\nline 2\nline 3\n```' });
  });

  it('truncates long file output to stay within Discord limits', async () => {
    const deps = createDeps({ readFile: vi.fn(async () => 'a'.repeat(2000)) });
    const interaction = createInteraction();

    await createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const reply = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { content: string };
    expect(reply.content.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain('truncated');
  });

  it('maps read failures to FILE_NOT_FOUND', async () => {
    const deps = createDeps({ readFile: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const interaction = createInteraction({ file: 'missing.ts' });

    await expect(createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
  });
});
