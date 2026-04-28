import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../utils/errors.js';
import { SessionBridge } from './sessionBridge.js';
import type { OpencodeSessionClient, StreamSubscriber } from './sessionBridge.js';
import type { SessionState } from '../state/types.js';

interface StateManagerStub {
  sessions: Map<string, SessionState>;
  getSession: ReturnType<typeof vi.fn<(threadId: string) => SessionState | undefined>>;
  setSession: ReturnType<typeof vi.fn<(threadId: string, session: SessionState) => void>>;
}

function createStateManager(): StateManagerStub {
  const sessions = new Map<string, SessionState>();

  return {
    sessions,
    getSession: vi.fn((threadId: string) => sessions.get(threadId)),
    setSession: vi.fn((threadId: string, session: SessionState) => {
      sessions.set(threadId, session);
    }),
  };
}

function createClient(overrides: Partial<OpencodeSessionClient['session']> = {}): OpencodeSessionClient {
  return {
    session: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      get: vi.fn(async () => ({ id: 'session-1' })),
      abort: vi.fn(async () => undefined),
      messages: vi.fn(async () => []),
      promptAsync: vi.fn(async () => undefined),
      ...overrides,
    },
  };
}

function createBridge(now = 1000): { bridge: SessionBridge; stateManager: StateManagerStub; streamSubscriber: StreamSubscriber } {
  const stateManager = createStateManager();
  const streamSubscriber: StreamSubscriber = {
    subscribe: vi.fn(async () => undefined),
  };

  return {
    bridge: new SessionBridge({ stateManager, streamSubscriber, now: () => now }),
    stateManager,
    streamSubscriber,
  };
}

describe('SessionBridge', () => {
  it('creates an SDK session, persists the thread mapping, and returns session state', async () => {
    const { bridge, stateManager } = createBridge(1234);
    const client = createClient({ create: vi.fn(async () => ({ data: { sessionID: 'session-123' } })) });

    const session = await bridge.createSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      title: 'Task thread',
    });

    expect(client.session.create).toHaveBeenCalledWith({ title: 'Task thread' });
    expect(session).toEqual({
      sessionId: 'session-123',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      createdAt: 1234,
      lastActivityAt: 1234,
      status: 'active',
    });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-1', session);
  });

  it('builds text and file prompt parts, parses model, and updates activity time', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const client = createClient();
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      createdAt: 1000,
      lastActivityAt: 1000,
      status: 'active',
    });

    await bridge.sendPrompt('thread-1', {
      client,
      content: 'Summarize this',
      files: [{ url: 'https://cdn.example/file.txt', mime: 'text/plain', filename: 'file.txt' }],
    });

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'session-1',
      parts: [
        { type: 'text', text: 'Summarize this' },
        { type: 'file', mime: 'text/plain', url: 'https://cdn.example/file.txt', filename: 'file.txt' },
      ],
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
    });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-1', {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      createdAt: 1000,
      lastActivityAt: 2000,
      status: 'active',
    });
  });

  it('connects to an existing session, replays history, subscribes streams, and recovers gaps', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(3000);
    const client = createClient({
      messages: vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            { info: { id: 'msg-2', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] },
            { info: { id: 'msg-1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
          ],
        })
        .mockResolvedValueOnce([
          { info: { id: 'msg-1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
          { info: { id: 'msg-3', role: 'assistant' }, parts: [{ type: 'text', text: 'new answer' }] },
        ]),
    });
    const thread = { send: vi.fn(async () => undefined) };

    await bridge.connectToSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      sessionId: 'session-1',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      historyLimit: 2,
      thread,
    });

    expect(client.session.get).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-1', {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 3000,
      lastActivityAt: 3000,
      status: 'active',
    });
    expect(streamSubscriber.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', client, expect.any(Set));
    expect(client.session.messages).toHaveBeenNthCalledWith(1, { sessionID: 'session-1', limit: 2 });
    expect(client.session.messages).toHaveBeenNthCalledWith(2, { sessionID: 'session-1' });
    expect(thread.send).toHaveBeenNthCalledWith(1, '**User:**\n> hello');
    expect(thread.send).toHaveBeenNthCalledWith(2, '**Assistant:**\ndone');
    expect(thread.send).toHaveBeenNthCalledWith(3, '**Assistant:**\nnew answer');
    expect(thread.send).toHaveBeenNthCalledWith(4, 'Connected to session `session-1`.');
  });

  it('continues connecting when history replay fails', async () => {
    const { bridge, streamSubscriber } = createBridge(3000);
    const client = createClient({
      messages: vi.fn().mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValueOnce([]),
    });
    const thread = { send: vi.fn(async () => undefined) };

    await bridge.connectToSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      sessionId: 'session-1',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      historyLimit: 10,
      thread,
    });

    expect(streamSubscriber.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', client, expect.any(Set));
    expect(thread.send).toHaveBeenCalledWith('Connected to session `session-1`.');
  });

  it('aborts an active session through the SDK client', async () => {
    const { bridge, stateManager } = createBridge();
    const client = createClient();
    stateManager.sessions.set('thread-1', {
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
    });

    await bridge.abortSession('thread-1', client);

    expect(client.session.abort).toHaveBeenCalledWith({ sessionID: 'session-1' });
  });

  it('throws and preserves activity time when promptAsync returns an SDK error envelope', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const client = createClient({ promptAsync: vi.fn(async () => ({ error: { name: 'NotFoundError' } })) });
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
    stateManager.sessions.set('thread-1', session);

    await expect(bridge.sendPrompt('thread-1', { client, content: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });

    expect(stateManager.setSession).not.toHaveBeenCalled();
    expect(stateManager.sessions.get('thread-1')).toEqual(session);
  });

  it('throws when abort returns an SDK error envelope', async () => {
    const { bridge, stateManager } = createBridge();
    const client = createClient({ abort: vi.fn(async () => ({ error: { name: 'AbortFailed' } })) });
    stateManager.sessions.set('thread-1', {
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
    });

    await expect(bridge.abortSession('thread-1', client)).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });

  it('throws SESSION_NOT_FOUND when sending to an absent session', async () => {
    const { bridge } = createBridge();

    await expect(bridge.sendPrompt('missing-thread', { client: createClient(), content: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });
});
