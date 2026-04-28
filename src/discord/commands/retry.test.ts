import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createRetryCommandHandler, type RetryCommandDependencies } from './retry.js';

function createSession(): SessionState {
  return { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'active' };
}

function createInteraction(): ChatInputCommandInteraction {
  return { channelId: 'thread-1', channel: { parentId: 'channel-1' }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
}

function createDeps(messages: unknown[] = [{ id: 'user-1', role: 'user', content: 'Try again' }, { id: 'assistant-1', role: 'assistant', content: 'No' }]): RetryCommandDependencies {
  const client = { session: { messages: vi.fn(async () => messages), revert: vi.fn(async () => undefined) } };
  return {
    stateManager: { getSession: vi.fn(() => createSession()) },
    serverManager: { getClient: vi.fn(() => client) },
    sessionBridge: { sendPrompt: vi.fn(async () => undefined) },
  };
}

describe('createRetryCommandHandler', () => {
  it('reverts the last assistant message and resends the last user prompt', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createRetryCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { messages: ReturnType<typeof vi.fn>; revert: ReturnType<typeof vi.fn> } };
    expect(client.session.messages).toHaveBeenCalledWith({ sessionID: 'session-1', limit: 20 });
    expect(client.session.revert).toHaveBeenCalledWith({ sessionID: 'session-1', messageID: 'assistant-1' });
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', { client, content: 'Try again' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Retrying last prompt.' });
  });

  it('defers before reading, reverting, and resending the session prompt', async () => {
    const events: string[] = [];
    const client = {
      session: {
        messages: vi.fn(async () => { events.push('messages'); return [{ id: 'user-1', role: 'user', content: 'Try again' }, { id: 'assistant-1', role: 'assistant', content: 'No' }]; }),
        revert: vi.fn(async () => { events.push('revert'); }),
      },
    };
    const deps: RetryCommandDependencies = {
      stateManager: { getSession: vi.fn(() => createSession()) },
      serverManager: { getClient: vi.fn(() => client) },
      sessionBridge: { sendPrompt: vi.fn(async () => { events.push('sendPrompt'); }) },
    };
    const interaction = createInteraction();
    vi.mocked(interaction.deferReply).mockImplementation(async () => { events.push('deferReply'); return {} as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>; });

    await createRetryCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(events).toEqual(['deferReply', 'messages', 'revert', 'sendPrompt']);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Retrying last prompt.' });
  });

  it('throws NO_MESSAGE_TO_RETRY when there is no user message', async () => {
    await expect(createRetryCommandHandler(createDeps([{ id: 'assistant-1', role: 'assistant' }]))(createInteraction(), { correlationId: 'corr-1' })).rejects.toMatchObject({
      code: ErrorCode.NO_MESSAGE_TO_RETRY,
    });
  });
});
