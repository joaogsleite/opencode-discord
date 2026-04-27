import type { Message } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateManager } from '../../state/manager.js';
import type { SessionState } from '../../state/types.js';
import {
  handleMessageCreate,
  type ContextBuffer,
  type ContextFile,
  type QuestionAnswerHandler,
  type SessionPromptBridge,
} from './messageHandler.js';

const NOW = 1_700_000_000_000;

interface MockMessageOptions {
  author?: { id: string; bot: boolean };
  content?: string;
  channelId?: string;
  channel?: { id: string; isThread: () => boolean };
}

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    guildId: 'guild-1',
    channelId: 'thread-1',
    projectPath: '/project',
    agent: 'build',
    model: 'model-1',
    createdBy: 'user-1',
    createdAt: NOW - 1_000,
    lastActivityAt: NOW - 500,
    status: 'active',
    ...overrides,
  };
}

function createMessage(overrides: MockMessageOptions = {}): Message {
  return {
    author: { id: 'user-1', bot: false },
    content: 'hello agent',
    channelId: 'thread-1',
    channel: { id: 'thread-1', isThread: () => true },
    ...overrides,
  } as unknown as Message;
}

function createStateManager(session?: SessionState): StateManager {
  return {
    getSession: vi.fn(() => session),
    setSession: vi.fn(),
    enqueue: vi.fn(),
  } as unknown as StateManager;
}

function createQuestionHandler(hasPendingQuestion = false): QuestionAnswerHandler {
  return {
    hasPendingQuestion: vi.fn(() => hasPendingQuestion),
    handleQuestionAnswer: vi.fn(),
  };
}

function createSessionBridge(isBusy = false): SessionPromptBridge {
  return {
    isBusy: vi.fn(() => isBusy),
    sendPrompt: vi.fn(),
  };
}

function createOptions(session?: SessionState, isBusy = false, hasPendingQuestion = false) {
  return {
    stateManager: createStateManager(session),
    questionHandler: createQuestionHandler(hasPendingQuestion),
    sessionBridge: createSessionBridge(isBusy),
    now: () => NOW,
  };
}

describe('handleMessageCreate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('ignores bot messages', async () => {
    const options = createOptions(createSession());
    const message = createMessage({ author: { id: 'bot-1', bot: true } });

    await handleMessageCreate(message, options);

    expect(options.questionHandler.hasPendingQuestion).not.toHaveBeenCalled();
    expect(options.stateManager.getSession).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores non-thread messages', async () => {
    const options = createOptions(createSession());
    const message = createMessage({
      channel: { id: 'channel-1', isThread: () => false },
    });

    await handleMessageCreate(message, options);

    expect(options.questionHandler.hasPendingQuestion).not.toHaveBeenCalled();
    expect(options.stateManager.getSession).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('intercepts answers when a pending question exists', async () => {
    const options = createOptions(createSession(), false, true);
    const message = createMessage({ content: 'yes' });

    await handleMessageCreate(message, options);

    expect(options.questionHandler.hasPendingQuestion).toHaveBeenCalledWith('thread-1');
    expect(options.questionHandler.handleQuestionAnswer).toHaveBeenCalledWith(
      'thread-1',
      'yes',
      expect.stringMatching(/^thread-1-\d+$/),
    );
    expect(options.stateManager.getSession).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores messages without a session', async () => {
    const options = createOptions(undefined);

    await handleMessageCreate(createMessage(), options);

    expect(options.stateManager.getSession).toHaveBeenCalledWith('thread-1');
    expect(options.sessionBridge.isBusy).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores messages for ended sessions', async () => {
    const options = createOptions(createSession({ status: 'ended' }));

    await handleMessageCreate(createMessage(), options);

    expect(options.sessionBridge.isBusy).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('queues active session messages when the bridge is busy', async () => {
    const session = createSession();
    const options = createOptions(session, true);
    const contextBuffer: ContextBuffer = { consume: vi.fn() };

    await handleMessageCreate(createMessage({ content: 'queue this' }), { ...options, contextBuffer });

    expect(options.sessionBridge.isBusy).toHaveBeenCalledWith('thread-1');
    expect(options.stateManager.enqueue).toHaveBeenCalledWith('thread-1', {
      userId: 'user-1',
      content: 'queue this',
      attachments: [],
      queuedAt: NOW,
    });
    expect(contextBuffer.consume).not.toHaveBeenCalled();
    expect(options.sessionBridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('forwards active session messages when the bridge is idle', async () => {
    const session = createSession();
    const options = createOptions(session);

    await handleMessageCreate(createMessage({ content: 'send this' }), options);

    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', 'send this', {
      session,
      correlationId: expect.stringMatching(/^thread-1-\d+$/),
      contextFiles: [],
    });
  });

  it('reactivates inactive sessions before forwarding', async () => {
    const session = createSession({ status: 'inactive' });
    const options = createOptions(session);

    await handleMessageCreate(createMessage(), options);

    const expectedSession: SessionState = { ...session, status: 'active', lastActivityAt: NOW };
    expect(options.stateManager.setSession).toHaveBeenCalledWith('thread-1', expectedSession);
    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith(
      'thread-1',
      'hello agent',
      expect.objectContaining({ session: expectedSession }),
    );
  });

  it('consumes context buffer files before forwarding', async () => {
    const contextFiles: ContextFile[] = [
      { path: '/tmp/context.txt', url: 'https://cdn.example/context.txt', mime: 'text/plain', filename: 'context.txt' },
    ];
    const options = createOptions(createSession());
    const contextBuffer: ContextBuffer = { consume: vi.fn(async () => contextFiles) };

    await handleMessageCreate(createMessage(), { ...options, contextBuffer });

    expect(contextBuffer.consume).toHaveBeenCalledWith('thread-1');
    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith(
      'thread-1',
      'hello agent',
      expect.objectContaining({ contextFiles }),
    );
  });

  it('prefers channel.id over message.channelId for thread ID', async () => {
    const session = createSession({ channelId: 'thread-from-channel' });
    const options = createOptions(session);
    const message = createMessage({
      channelId: 'thread-from-message',
      channel: { id: 'thread-from-channel', isThread: () => true },
    });

    await handleMessageCreate(message, options);

    expect(options.stateManager.getSession).toHaveBeenCalledWith('thread-from-channel');
    expect(options.sessionBridge.sendPrompt).toHaveBeenCalledWith(
      'thread-from-channel',
      'hello agent',
      expect.objectContaining({ correlationId: expect.stringMatching(/^thread-from-channel-\d+$/) }),
    );
  });
});
