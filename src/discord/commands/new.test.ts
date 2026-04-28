import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createNewCommandHandler, type NewCommandDependencies } from './new.js';

function createInteraction(options: { channel?: unknown; prompt?: string; agent?: string | null; title?: string | null } = {}): ChatInputCommandInteraction {
  return {
    channelId: 'channel-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    channel: options.channel ?? { threads: { create: vi.fn(async () => ({ id: 'thread-1', send: vi.fn() })) } },
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === 'prompt') {
          return options.prompt ?? (required ? 'Build feature' : null);
        }
        if (name === 'agent') {
          return options.agent ?? null;
        }
        if (name === 'title') {
          return options.title ?? null;
        }
        return null;
      }),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<NewCommandDependencies> = {}): NewCommandDependencies {
  return {
    serverManager: { ensureRunning: vi.fn(async () => ({ session: {} })) },
    sessionBridge: {
      createSession: vi.fn(async () => ({
        sessionId: 'session-1',
        guildId: 'guild-1',
        channelId: 'channel-1',
        projectPath: '/repo',
        agent: 'build',
        model: null,
        createdBy: 'user-1',
        createdAt: 1000,
        lastActivityAt: 1000,
        status: 'active' as const,
      })),
      sendPrompt: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe('createNewCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo', defaultAgent: 'build' };

  it('creates a thread and session, sends the first prompt, and edits the deferred reply', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined) };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel, prompt: 'Build feature', title: 'Feature work' });

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(channel.threads.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Feature work' }));
    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      title: 'Feature work',
    }));
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', expect.objectContaining({ content: 'Build feature', agent: 'build' }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('thread-1') }));
  });

  it('rejects disallowed requested agents before starting OpenCode', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ agent: 'debug' });

    await expect(createNewCommandHandler(deps)(interaction, {
      correlationId: 'corr-1',
      channelConfig: { ...channelConfig, allowedAgents: ['build'] },
    })).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_ALLOWED });

    expect(deps.serverManager.ensureRunning).not.toHaveBeenCalled();
  });
});
