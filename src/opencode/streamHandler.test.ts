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

    expect(sends).toEqual(['Hello']);
    expect(edits.at(-1)).toBe('Hello world');
  });

  it('splits long streamed messages at formatter boundaries', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([textDelta(`${'a'.repeat(1801)}\n\n${'b'.repeat(20)}`)])]);

    await handler.subscribe('thread-1', 'session-1', client);

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

    expect(questionHandler.handleQuestionEvent).toHaveBeenCalledWith('thread-1', expect.objectContaining({ type: 'question.asked' }), client);
    expect(permissionHandler.handlePermissionEvent).toHaveBeenCalledWith('thread-1', expect.objectContaining({ type: 'permission.asked' }), client);
  });

  it('throttles message edits to the configured interval', async () => {
    const { thread, message } = createThread();
    const times = [0, 100, 200, 1200];
    const handler = createHandler({ editThrottleMs: 1000, now: () => times.shift() ?? 1200 }, thread);
    const client = createClient([stream([textDelta('A'), textDelta('B'), textDelta('C'), textDelta('D')])]);

    await handler.subscribe('thread-1', 'session-1', client);

    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(message.edit).toHaveBeenCalledWith('ABCD');
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

    expect(client.global.event).toHaveBeenCalledTimes(4);
    expect(sends.at(-1)).toContain('Stream disconnected after 3 retries.');
  });
});
