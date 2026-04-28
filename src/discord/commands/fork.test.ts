import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { createForkCommandHandler, type ForkCommandDependencies } from './fork.js';

function createSession(): SessionState {
  return { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'build', model: 'anthropic/sonnet', createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'active' };
}

function createInteraction(): ChatInputCommandInteraction {
  const forkThread = { id: 'thread-2', send: vi.fn(async () => undefined), url: 'https://discord.test/thread-2' };
  const parent = { threads: { create: vi.fn(async () => forkThread) } };
  return {
    channelId: 'thread-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    channel: { parentId: 'channel-1', parent, send: vi.fn(async () => undefined), url: 'https://discord.test/thread-1' },
    options: { getString: vi.fn((name: string) => name === 'title' ? 'Fork title' : 'message-1') },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(): ForkCommandDependencies {
  const client = { session: { fork: vi.fn(async () => ({ id: 'session-2' })) } };
  return {
    stateManager: { getSession: vi.fn(() => createSession()), setSession: vi.fn() },
    serverManager: { getClient: vi.fn(() => client) },
    streamHandler: { subscribe: vi.fn(async () => undefined) },
    now: vi.fn(() => 123),
  };
}

describe('createForkCommandHandler', () => {
  it('forks the session, creates a sibling thread, persists mapping, subscribes SSE, and cross-links', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createForkCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { fork: ReturnType<typeof vi.fn> } };
    const parent = (interaction.channel as unknown as { parent: { threads: { create: ReturnType<typeof vi.fn> } } }).parent;
    expect(client.session.fork).toHaveBeenCalledWith({ sessionID: 'session-1', messageID: 'message-1' });
    expect(parent.threads.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Fork title' }));
    expect(deps.stateManager.setSession).toHaveBeenCalledWith('thread-2', expect.objectContaining({ sessionId: 'session-2', channelId: 'channel-1' }));
    expect(deps.streamHandler.subscribe).toHaveBeenCalledWith('thread-2', 'session-2', client, expect.any(Set), '/repo');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Forked session into <#thread-2>.' });
  });
});
