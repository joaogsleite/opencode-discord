import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createDownloadCommandHandler, type DownloadCommandDependencies } from './download.js';

function createInteraction(file = 'report.txt'): ChatInputCommandInteraction {
  return {
    options: {
      getString: vi.fn((name: string, required?: boolean) => name === 'file' ? file : required ? file : null),
    },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<DownloadCommandDependencies> = {}): DownloadCommandDependencies {
  return {
    resolveSafePath: vi.fn(() => '/repo/report.txt'),
    verifyReadable: vi.fn(async () => ({ isFile: true })),
    createAttachment: vi.fn(() => ({ name: 'report.txt' })),
    ...overrides,
  };
}

describe('createDownloadCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('sends a resolved file as a Discord attachment', async () => {
    const attachment = { name: 'report.txt' };
    const deps = createDeps({ createAttachment: vi.fn(() => attachment) });
    const interaction = createInteraction('report.txt');

    await createDownloadCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.resolveSafePath).toHaveBeenCalledWith('/repo', 'report.txt');
    expect(deps.verifyReadable).toHaveBeenCalledWith('/repo/report.txt');
    expect(deps.createAttachment).toHaveBeenCalledWith('/repo/report.txt', 'report.txt');
    expect(interaction.reply).toHaveBeenCalledWith({ files: [attachment] });
  });

  it('maps unreadable files to FILE_NOT_FOUND before creating an attachment', async () => {
    const deps = createDeps({ verifyReadable: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const interaction = createInteraction('missing.txt');

    await expect(createDownloadCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('rejects directories before creating an attachment', async () => {
    const deps = createDeps({ verifyReadable: vi.fn(async () => ({ isFile: false })) });
    const interaction = createInteraction('src');

    await expect(createDownloadCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
    expect(deps.createAttachment).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('maps attachment creation failures to FILE_NOT_FOUND', async () => {
    const deps = createDeps({ createAttachment: vi.fn(() => { throw new Error('ENOENT'); }) });
    const interaction = createInteraction('missing.txt');

    await expect(createDownloadCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.FILE_NOT_FOUND,
    });
  });
});
