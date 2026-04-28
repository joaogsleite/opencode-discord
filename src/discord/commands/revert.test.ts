import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createRevertCommandHandler, createUnrevertCommandHandler, getRevertAutocompleteChoices, type RevertCommandDependencies } from './revert.js';

function createInteraction(message: string | null = null): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    channel: { parentId: 'channel-1' },
    options: { getString: vi.fn(() => message) },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createSession(): SessionState {
  return { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'active' };
}

function createDeps(messages: unknown[] = [{ id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }]): RevertCommandDependencies {
  const client = {
    session: {
      messages: vi.fn(async () => messages),
      revert: vi.fn(async () => undefined),
      unrevert: vi.fn(async () => undefined),
    },
  };
  return {
    stateManager: { getSession: vi.fn(() => createSession()) },
    serverManager: { getClient: vi.fn(() => client) },
  };
}

describe('revert command handlers', () => {
  it('reverts the last assistant message when no message option is provided', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createRevertCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { messages: ReturnType<typeof vi.fn>; revert: ReturnType<typeof vi.fn> } };
    expect(client.session.messages).toHaveBeenCalledWith({ sessionID: 'session-1', limit: 15 });
    expect(client.session.revert).toHaveBeenCalledWith({ sessionID: 'session-1', messageID: 'assistant-1' });
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Reverted message `assistant-1`.' });
  });

  it('throws NO_MESSAGE_TO_REVERT when no assistant message exists', async () => {
    const deps = createDeps([{ id: 'user-1', role: 'user', content: 'Hi' }]);

    await expect(createRevertCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1' })).rejects.toMatchObject({
      code: ErrorCode.NO_MESSAGE_TO_REVERT,
    });
  });

  it('unreverts the current session', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createUnrevertCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { unrevert: ReturnType<typeof vi.fn> } };
    expect(client.session.unrevert).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Last revert undone.' });
  });

  it('returns last 15 assistant messages as autocomplete choices', () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({ id: `assistant-${index}`, role: 'assistant', parts: [{ type: 'text', text: `Assistant message ${index}` }] }));

    expect(getRevertAutocompleteChoices(messages)).toHaveLength(15);
    expect(getRevertAutocompleteChoices(messages)[0]).toEqual({ name: 'Assistant message 1', value: 'assistant-1' });
  });
});
