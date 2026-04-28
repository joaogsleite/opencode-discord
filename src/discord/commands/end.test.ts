import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createEndCommandHandler, type EndCommandDependencies } from './end.js';

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

describe('createEndCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('aborts the session, removes mapping and queue, archives the thread, and replies', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1', setArchived: vi.fn(async () => undefined) }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: EndCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), removeSession: vi.fn(), clearQueue: vi.fn() },
      serverManager: { getClient: vi.fn(() => ({ session: {} })) },
      sessionBridge: { abortSession: vi.fn(async () => undefined) },
    };

    await createEndCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.sessionBridge.abortSession).toHaveBeenCalledWith('thread-1', { session: {} });
    expect(deps.stateManager.removeSession).toHaveBeenCalledWith('thread-1');
    expect(deps.stateManager.clearQueue).toHaveBeenCalledWith('thread-1');
    expect((interaction.channel as unknown as { setArchived: ReturnType<typeof vi.fn> }).setArchived).toHaveBeenCalledWith(true);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ended') }));
  });

  it('cleans up session attachments when an attachment cleanup dependency is supplied', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1', setArchived: vi.fn(async () => undefined) }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const attachmentCleanup = { cleanupSession: vi.fn(async () => undefined) };
    const deps: EndCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), removeSession: vi.fn(), clearQueue: vi.fn() },
      serverManager: { getClient: vi.fn(() => ({ session: {} })) },
      sessionBridge: { abortSession: vi.fn(async () => undefined) },
      attachmentCleanup,
    };

    await createEndCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(attachmentCleanup.cleanupSession).toHaveBeenCalledWith('thread-1', session);
    expect(deps.stateManager.removeSession).toHaveBeenCalledWith('thread-1');
  });

  it('continues ending the session when attachment cleanup fails', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1', setArchived: vi.fn(async () => undefined) }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: EndCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), removeSession: vi.fn(), clearQueue: vi.fn() },
      serverManager: { getClient: vi.fn(() => ({ session: {} })) },
      sessionBridge: { abortSession: vi.fn(async () => undefined) },
      attachmentCleanup: { cleanupSession: vi.fn(async () => { throw new Error('cleanup failed'); }) },
    };

    await createEndCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.stateManager.clearQueue).toHaveBeenCalledWith('thread-1');
    expect(deps.stateManager.removeSession).toHaveBeenCalledWith('thread-1');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ended') }));
    expect((interaction.channel as unknown as { setArchived: ReturnType<typeof vi.fn> }).setArchived).toHaveBeenCalledWith(true);
  });

  it('replies before archiving the thread', async () => {
    const events: string[] = [];
    const interaction = {
      channelId: 'thread-1',
      channel: { parentId: 'channel-1', setArchived: vi.fn(async () => { events.push('archive'); }) },
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => { events.push('editReply'); }),
    } as unknown as ChatInputCommandInteraction;
    const deps: EndCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), removeSession: vi.fn(), clearQueue: vi.fn() },
      serverManager: { getClient: vi.fn(() => ({ session: {} })) },
      sessionBridge: { abortSession: vi.fn(async () => undefined) },
    };

    await createEndCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(events).toEqual(['editReply', 'archive']);
  });

  it('defers before aborting and cleaning up session resources', async () => {
    const events: string[] = [];
    const interaction = {
      channelId: 'thread-1',
      channel: { parentId: 'channel-1', setArchived: vi.fn(async () => undefined) },
      deferReply: vi.fn(async () => { events.push('deferReply'); }),
      editReply: vi.fn(async () => undefined),
    } as unknown as ChatInputCommandInteraction;
    const deps: EndCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), removeSession: vi.fn(), clearQueue: vi.fn() },
      serverManager: { getClient: vi.fn(() => ({ session: {} })) },
      sessionBridge: { abortSession: vi.fn(async () => { events.push('abortSession'); }) },
      attachmentCleanup: { cleanupSession: vi.fn(async () => { events.push('cleanupSession'); }) },
    };

    await createEndCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(events).toEqual(['deferReply', 'abortSession', 'cleanupSession']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ended') }));
  });

  it('requires an attached session', async () => {
    const deps: EndCommandDependencies = {
      stateManager: { getSession: vi.fn(() => undefined), removeSession: vi.fn(), clearQueue: vi.fn() },
      serverManager: { getClient: vi.fn(() => undefined) },
      sessionBridge: { abortSession: vi.fn(async () => undefined) },
    };

    await expect(createEndCommandHandler(deps)({ channelId: 'thread-1', channel: { parentId: 'channel-1' } } as unknown as ChatInputCommandInteraction, {
      correlationId: 'corr-1',
      channelConfig,
    })).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });
  });
});
