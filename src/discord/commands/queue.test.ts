import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../utils/errors.js';
import { createQueueCommandHandler, type QueueCommandDependencies } from './queue.js';

function createInteraction(subcommand: string, channel: unknown = { id: 'thread-1', parentId: 'channel-1' }): ChatInputCommandInteraction {
  return {
    channel,
    channelId: 'thread-1',
    options: { getSubcommand: vi.fn(() => subcommand) },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<QueueCommandDependencies> = {}): QueueCommandDependencies {
  return {
    stateManager: {
      getQueue: vi.fn(() => [{ userId: 'user-1', content: 'queued message body', attachments: [], queuedAt: 1000 }]),
      clearQueue: vi.fn(),
    },
    ...overrides,
  };
}

describe('createQueueCommandHandler', () => {
  it('lists queued messages for the current thread', async () => {
    const deps = createDeps();
    const interaction = createInteraction('list');

    await createQueueCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.stateManager.getQueue).toHaveBeenCalledWith('thread-1');
    expect(interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining('1. <@user-1>: queued message body') });
  });

  it('truncates large queue listings to stay within Discord limits', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      userId: `user-${index}`,
      content: `queued message ${index} ${'x'.repeat(80)}`,
      attachments: [],
      queuedAt: index,
    }));
    const deps = createDeps({ stateManager: { getQueue: vi.fn(() => entries), clearQueue: vi.fn() } });
    const interaction = createInteraction('list');

    await createQueueCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const reply = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { content: string };
    expect(reply.content.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain('truncated');
  });

  it('clears queued messages for the current thread', async () => {
    const deps = createDeps();
    const interaction = createInteraction('clear');

    await createQueueCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.stateManager.clearQueue).toHaveBeenCalledWith('thread-1');
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Queue cleared.' });
  });

  it('persists the queue after clearing when the state dependency exposes explicit save', async () => {
    const save = vi.fn();
    const deps = createDeps({
      stateManager: {
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
        save,
      },
    });
    const interaction = createInteraction('clear');

    await createQueueCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.stateManager.clearQueue).toHaveBeenCalledWith('thread-1');
    expect(save).toHaveBeenCalledWith();
  });

  it('rejects use outside a thread', async () => {
    const deps = createDeps();
    const interaction = createInteraction('list', { id: 'channel-1' });

    await expect(createQueueCommandHandler(deps)(interaction, { correlationId: 'corr-1' })).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    });
  });
});
