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
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<CatCommandDependencies> = {}): CatCommandDependencies {
  return {
    resolveSafePath: vi.fn(() => '/repo/src/index.ts'),
    readFile: vi.fn(async () => 'line 1\nline 2\nline 3'),
    inferLanguage: vi.fn(() => 'typescript'),
    createAttachment: vi.fn((content: string, name: string) => ({ content, name })),
    ...overrides,
  };
}

describe('createCatCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('reads a safe file path, applies line range, and replies with an inline code block', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ file: 'src/index.ts', start: 2, end: 3 });

    await createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.resolveSafePath).toHaveBeenCalledWith('/repo', 'src/index.ts');
    expect(deps.readFile).toHaveBeenCalledWith('/repo/src/index.ts');
    expect(deps.inferLanguage).toHaveBeenCalledWith('/repo/src/index.ts');
    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'File: `/repo/src/index.ts` (lines 2-3)\n```typescript\nline 2\nline 3\n```' });
  });

  it('splits long file output across inline code block messages without truncating', async () => {
    const deps = createDeps({ readFile: vi.fn(async () => 'a'.repeat(2000)) });
    const interaction = createInteraction();

    await createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.createAttachment).not.toHaveBeenCalled();
    const firstContent = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { content: string };
    expect(interaction.followUp).toHaveBeenCalled();
    const followUpContent = vi.mocked(interaction.followUp).mock.calls[0]?.[0] as { content: string };
    expect(firstContent.content).toMatch(/^File: `\/repo\/src\/index\.ts`\n```typescript\n/);
    expect(firstContent.content.length).toBeLessThanOrEqual(2000);
    expect(followUpContent.content).toMatch(/^```typescript\n/);
    expect(followUpContent.content.length).toBeLessThanOrEqual(2000);
    expect(`${firstContent.content}\n${followUpContent.content}`).not.toContain('... truncated');
  });

  it('truncates extremely long file output after sending inline code blocks', async () => {
    const deps = createDeps({ readFile: vi.fn(async () => 'a'.repeat(25_000)) });
    const interaction = createInteraction();

    await createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const sent = [
      vi.mocked(interaction.reply).mock.calls[0]?.[0],
      ...vi.mocked(interaction.followUp).mock.calls.map((call) => call[0]),
    ] as Array<{ content: string }>;
    expect(sent.at(-1)?.content).toContain('... truncated');
    expect(sent.every((message) => message.content.length <= 2000)).toBe(true);
  });

  it('escapes triple backticks inside file content code blocks', async () => {
    const deps = createDeps({ readFile: vi.fn(async () => 'before\n```ts\ninside\n```\nafter') });
    const interaction = createInteraction();

    await createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.reply).toHaveBeenCalledWith({ content: 'File: `/repo/src/index.ts`\n```typescript\nbefore\n`\u200b``ts\ninside\n`\u200b``\nafter\n```' });
  });

  it('maps read failures to FILE_NOT_FOUND', async () => {
    const deps = createDeps({ readFile: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const interaction = createInteraction({ file: 'missing.ts' });

    await expect(createCatCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
  });
});
