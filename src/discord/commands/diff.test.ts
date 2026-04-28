import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createDiffCommandHandler, type DiffCommandDependencies } from './diff.js';

function createInteraction(): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    channel: { parentId: 'channel-1' },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    projectPath: '/repo',
    agent: 'build',
    model: null,
    createdBy: 'user-1',
    createdAt: 1,
    lastActivityAt: 1,
    status: 'active',
    ...overrides,
  };
}

function createDeps(overrides: Partial<DiffCommandDependencies> = {}): DiffCommandDependencies {
  const client = { session: { diff: vi.fn(async () => 'diff --git a/file.ts b/file.ts') } };
  return {
    stateManager: { getSession: vi.fn(() => createSession()) },
    serverManager: { getClient: vi.fn(() => client) },
    splitMessage: vi.fn((text: string) => [text]),
    ...overrides,
  };
}

describe('createDiffCommandHandler', () => {
  it('formats session diff as a diff code block', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createDiffCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { diff: ReturnType<typeof vi.fn> } };
    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(client.session.diff).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(deps.splitMessage).toHaveBeenCalledWith('```diff\ndiff --git a/file.ts b/file.ts\n```');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '```diff\ndiff --git a/file.ts b/file.ts\n```' });
  });

  it('uses matching three-backtick diff fences', async () => {
    const deps = createDeps();

    await createDiffCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1' });

    expect(deps.splitMessage).toHaveBeenCalledTimes(1);
    const splitMessage = deps.splitMessage;
    expect(splitMessage).toBeDefined();
    const call = vi.mocked(splitMessage!).mock.calls[0];
    expect(call).toBeDefined();
    const formatted = call?.[0];
    expect(formatted?.startsWith('```diff\n')).toBe(true);
    expect(formatted?.startsWith('````diff')).toBe(false);
    expect(formatted).toBe('```diff\ndiff --git a/file.ts b/file.ts\n```');
  });

  it('reports no changes when session diff is empty', async () => {
    const client = { session: { diff: vi.fn(async () => '') } };
    const deps = createDeps({ serverManager: { getClient: vi.fn(() => client) } });
    const interaction = createInteraction();

    await createDiffCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'No file changes in this session.' });
  });

  it('requires a session thread', async () => {
    const interaction = { ...createInteraction(), channel: { parentId: null } } as unknown as ChatInputCommandInteraction;

    await expect(createDiffCommandHandler(createDeps())(interaction, { correlationId: 'corr-1' })).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    });
  });
});
