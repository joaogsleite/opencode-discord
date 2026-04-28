import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { createSummaryCommandHandler, type SummaryCommandDependencies } from './summary.js';

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'build', model: 'anthropic/claude', createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'active', ...overrides };
}

function createInteraction(model: string | null = null): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    channel: { parentId: 'channel-1' },
    options: { getString: vi.fn(() => model) },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(session: SessionState = createSession()): SummaryCommandDependencies {
  const client = { session: { summarize: vi.fn(async () => 'Short summary') } };
  return { stateManager: { getSession: vi.fn(() => session) }, serverManager: { getClient: vi.fn(() => client) } };
}

describe('createSummaryCommandHandler', () => {
  it('passes an explicit provider/model to session.summarize', async () => {
    const deps = createDeps();
    const interaction = createInteraction('openai/gpt-4.1');

    await createSummaryCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { summarize: ReturnType<typeof vi.fn> } };
    expect(client.session.summarize).toHaveBeenCalledWith({ sessionID: 'session-1', providerID: 'openai', modelID: 'gpt-4.1' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Short summary' });
  });

  it('uses the session model when the option is omitted', async () => {
    const deps = createDeps(createSession({ model: 'anthropic/sonnet' }));

    await createSummaryCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { summarize: ReturnType<typeof vi.fn> } };
    expect(client.session.summarize).toHaveBeenCalledWith({ sessionID: 'session-1', providerID: 'anthropic', modelID: 'sonnet' });
  });

  it('splits long summary output into bounded Discord messages', async () => {
    const longSummary = 'a'.repeat(2500);
    const client = { session: { summarize: vi.fn(async () => longSummary) } };
    const deps = createDeps();
    deps.serverManager.getClient = vi.fn(() => client);
    deps.splitMessage = vi.fn(() => ['a'.repeat(1800), 'a'.repeat(700)]);
    const interaction = createInteraction();

    await createSummaryCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.splitMessage).toHaveBeenCalledWith(longSummary);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'a'.repeat(1800) });
    expect(interaction.followUp).toHaveBeenCalledWith({ content: 'a'.repeat(700) });
  });
});
