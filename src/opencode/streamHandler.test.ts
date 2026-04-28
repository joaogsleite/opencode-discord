import { describe, expect, it, vi } from 'vitest';
import { StreamHandler } from './streamHandler.js';
import type { GlobalEventLike, OpenCodeStreamClient, StreamHandlerOptions, StreamMessage, StreamThread } from './streamHandler.js';

function stream(events: GlobalEventLike[]): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function failingStream(error: Error): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  };
}

function neverEndingStream(): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<never>(() => undefined);
    },
  };
}

function controlledStream(): { events: GlobalEventLike[]; iterable: AsyncIterable<GlobalEventLike>; release: () => void } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: GlobalEventLike[] = [];

  return {
    events,
    release,
    iterable: {
      async *[Symbol.asyncIterator]() {
        await released;
        yield* events;
      },
    },
  };
}

function textDelta(delta: string, partID = 'part-1', sessionID = 'session-1'): GlobalEventLike {
  return {
    directory: '/repo',
    payload: { type: 'message.part.delta', sessionID, partID, field: 'text', delta },
  };
}

function createThread(): { thread: StreamThread; message: StreamMessage; edits: string[]; sends: string[] } {
  const edits: string[] = [];
  const sends: string[] = [];
  const message: StreamMessage = {
    edit: vi.fn(async (content: string) => {
      edits.push(content);
    }),
  };
  const thread: StreamThread = {
    send: vi.fn(async (content: string) => {
      sends.push(content);
      return message;
    }),
  };

  return { thread, message, edits, sends };
}

function createClient(events: AsyncIterable<GlobalEventLike>[]): OpenCodeStreamClient {
  let index = 0;

  return {
    global: {
      event: vi.fn(async () => events[index++] ?? stream([])),
    },
  };
}

function createHandler(options: Partial<StreamHandlerOptions> = {}, thread = createThread().thread): StreamHandler {
  return new StreamHandler({
    getThread: () => thread,
    questionHandler: { handleQuestionEvent: vi.fn(async () => undefined) },
    permissionHandler: { handlePermissionEvent: vi.fn(async () => undefined) },
    editThrottleMs: 0,
    retryDelayMs: 0,
    ...options,
  });
}

describe('StreamHandler', () => {
  it('subscribes to client global events', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([])]);

    await handler.subscribe('thread-1', 'session-1', client);

    expect(client.global.event).toHaveBeenCalledTimes(1);
  });

  it('accumulates text deltas per partID', async () => {
    const { thread, edits, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([textDelta('Hello'), textDelta(' world')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['Hello']);
    expect(edits.at(-1)).toBe('Hello world');
  });

  it('filters stream events by project directory when projectPath is provided', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        { directory: '/other', payload: { type: 'message.part.delta', sessionID: 'session-1', partID: 'part-1', field: 'text', delta: 'noise' } },
        { directory: '/repo', payload: { type: 'message.part.delta', sessionID: 'session-1', partID: 'part-1', field: 'text', delta: 'signal' } },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client, undefined, '/repo');
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['signal']);
  });

  it('returns promptly after starting a never-ending stream pump', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([neverEndingStream()]);

    const result = await Promise.race([handler.subscribe('thread-1', 'session-1', client), Promise.resolve('blocked')]);
    handler.unsubscribe('thread-1');

    expect(result).not.toBe('blocked');
  });

  it('cancels the previous pump when subscribing a thread again', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const firstStream = controlledStream();
    const secondStream = controlledStream();
    const firstClient = createClient([firstStream.iterable]);
    const secondClient = createClient([secondStream.iterable]);

    await handler.subscribe('thread-1', 'session-1', firstClient);
    await handler.subscribe('thread-1', 'session-1', secondClient);
    firstStream.events.push(textDelta('old'));
    secondStream.events.push(textDelta('new'));
    firstStream.release();
    secondStream.release();
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['new']);
  });

  it('tracks streamed message IDs in the provided dedupe set', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const dedupeSet = new Set<string>();
    const client = createClient([
      stream([
        { directory: '/repo', payload: { type: 'message.part.delta', sessionID: 'session-1', messageID: 'msg-1', partID: 'part-1', field: 'text', delta: 'A' } },
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: { id: 'tool-1', type: 'tool', tool: 'bash', state: { status: 'running' } },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client, dedupeSet);
    await handler.waitForIdle('thread-1');

    expect(dedupeSet.has('msg-1')).toBe(true);
  });

  it('ignores session-scoped events without a session ID', async () => {
    const { thread, sends } = createThread();
    const questionHandler = { handleQuestionEvent: vi.fn(async () => undefined) };
    const permissionHandler = { handlePermissionEvent: vi.fn(async () => undefined) };
    const handler = createHandler({ questionHandler, permissionHandler }, thread);
    const client = createClient([
      stream([
        { directory: '/repo', payload: { type: 'message.part.delta', partID: 'part-1', field: 'text', delta: 'noise' } },
        { directory: '/repo', payload: { type: 'question.asked', request: { id: 'q1' } } },
        { directory: '/repo', payload: { type: 'permission.asked', request: { id: 'p1' } } },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual([]);
    expect(questionHandler.handleQuestionEvent).not.toHaveBeenCalled();
    expect(permissionHandler.handlePermissionEvent).not.toHaveBeenCalled();
  });

  it('splits long streamed messages at formatter boundaries', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([textDelta(`${'a'.repeat(1801)}\n\n${'b'.repeat(20)}`)])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends.length).toBeGreaterThan(1);
    expect(sends.every((content) => content.length <= 1800)).toBe(true);
  });

  it('detects tables and delegates table handling', async () => {
    const { thread } = createThread();
    const tableHandler = { handleTable: vi.fn(async () => undefined) };
    const handler = createHandler({ tableHandler }, thread);
    const table = '| Name | Value |\n| --- | --- |\n| A | 1 |';
    const client = createClient([stream([textDelta(table)])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(tableHandler.handleTable).toHaveBeenCalledWith('thread-1', table);
  });

  it('shows running tool status on stream messages', async () => {
    const { thread, edits } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        textDelta('Working'),
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            part: { id: 'tool-1', type: 'tool', tool: 'bash', state: { status: 'running' } },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(edits.at(-1)).toContain('Running: bash');
  });

  it('delegates question and permission events', async () => {
    const { thread } = createThread();
    const questionHandler = { handleQuestionEvent: vi.fn(async () => undefined) };
    const permissionHandler = { handlePermissionEvent: vi.fn(async () => undefined) };
    const handler = createHandler({ questionHandler, permissionHandler }, thread);
    const client = createClient([
      stream([
        { directory: '/repo', payload: { type: 'question.asked', sessionID: 'session-1', request: { id: 'q1' } } },
        { directory: '/repo', payload: { type: 'permission.asked', sessionID: 'session-1', request: { id: 'p1' } } },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(questionHandler.handleQuestionEvent).toHaveBeenCalledWith('thread-1', expect.objectContaining({ type: 'question.asked' }), client);
    expect(permissionHandler.handlePermissionEvent).toHaveBeenCalledWith('thread-1', expect.objectContaining({ type: 'permission.asked' }), client);
  });

  it('delegates nested question and permission request session IDs', async () => {
    const { thread } = createThread();
    const questionHandler = { handleQuestionEvent: vi.fn(async () => undefined) };
    const permissionHandler = { handlePermissionEvent: vi.fn(async () => undefined) };
    const handler = createHandler({ questionHandler, permissionHandler }, thread);
    const client = createClient([
      stream([
        { directory: '/repo', payload: { type: 'question.asked', request: { id: 'q1', sessionID: 'session-1' } } },
        { directory: '/repo', payload: { type: 'permission.asked', request: { id: 'p1', sessionID: 'session-1' } } },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(questionHandler.handleQuestionEvent).toHaveBeenCalledWith('thread-1', expect.objectContaining({ type: 'question.asked' }), client);
    expect(permissionHandler.handlePermissionEvent).toHaveBeenCalledWith('thread-1', expect.objectContaining({ type: 'permission.asked' }), client);
  });

  it('continues streaming when table handling fails', async () => {
    const { thread, sends } = createThread();
    const tableHandler = { handleTable: vi.fn(async () => {
      throw new Error('render failed');
    }) };
    const handler = createHandler({ tableHandler }, thread);
    const table = '| Name | Value |\n| --- | --- |\n| A | 1 |';
    const client = createClient([stream([textDelta(table)])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(client.global.event).toHaveBeenCalledTimes(1);
    expect(tableHandler.handleTable).toHaveBeenCalledWith('thread-1', table);
    expect(sends).toEqual([table]);
  });

  it('throttles message edits to the configured interval', async () => {
    const { thread, message } = createThread();
    const times = [0, 100, 200, 1200];
    const handler = createHandler({ editThrottleMs: 1000, now: () => times.shift() ?? 1200 }, thread);
    const client = createClient([stream([textDelta('A'), textDelta('B'), textDelta('C'), textDelta('D')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(message.edit).toHaveBeenCalledWith('ABCD');
  });

  it('flushes final content when a finite stream ends before throttle elapses', async () => {
    const { thread, edits } = createThread();
    const times = [0, 100, 200];
    const handler = createHandler({ editThrottleMs: 1000, now: () => times.shift() ?? 200 }, thread);
    const client = createClient([stream([textDelta('A'), textDelta('B'), textDelta('C')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(edits.at(-1)).toBe('ABC');
  });

  it('reconnects three times and notifies the thread after repeated SSE failures', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({ maxRetries: 3 }, thread);
    const client = createClient([
      failingStream(new Error('disconnect 1')),
      failingStream(new Error('disconnect 2')),
      failingStream(new Error('disconnect 3')),
      failingStream(new Error('disconnect 4')),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(client.global.event).toHaveBeenCalledTimes(4);
    expect(sends.at(-1)).toContain('Stream disconnected after 3 retries.');
  });

  it('contains Discord send failures from the background pump', async () => {
    const thread: StreamThread = {
      send: vi.fn(async () => {
        throw new Error('discord unavailable');
      }),
    };
    const handler = createHandler({ maxRetries: 0 }, thread);
    const client = createClient([failingStream(new Error('disconnect'))]);

    await handler.subscribe('thread-1', 'session-1', client);

    await expect(handler.waitForIdle('thread-1')).resolves.toBeUndefined();
  });
});
