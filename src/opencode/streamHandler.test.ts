import { afterEach, describe, expect, it, vi } from 'vitest';
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

function streamThenNever(events: GlobalEventLike[]): { drained: Promise<void>; iterable: AsyncIterable<GlobalEventLike> } {
  let resolveDrained: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  return {
    drained,
    iterable: {
      async *[Symbol.asyncIterator]() {
        yield* events;
        resolveDrained();
        await new Promise<never>(() => undefined);
      },
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

function textDelta(delta: string, partID = 'part-1', sessionID = 'session-1', messageID?: string): GlobalEventLike {
  return {
    directory: '/repo',
    payload: { type: 'message.part.delta', sessionID, messageID, partID, field: 'text', delta },
  };
}

function createThread(): { thread: StreamThread; message: StreamMessage; edits: string[]; sends: string[]; typing: ReturnType<typeof vi.fn> } {
  const edits: string[] = [];
  const sends: string[] = [];
  const typing = vi.fn(async () => undefined);
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
    sendTyping: typing,
  };

  return { thread, message, edits, sends, typing };
}

function createClient(events: AsyncIterable<GlobalEventLike>[]): OpenCodeStreamClient {
  let index = 0;

  return {
    global: {
      event: vi.fn(async () => events[index++] ?? stream([])),
    },
  };
}

function createSseResultClient(events: AsyncIterable<GlobalEventLike>[]): OpenCodeStreamClient {
  let index = 0;

  return {
    global: {
      event: vi.fn(async () => ({ stream: events[index++] ?? stream([]) })),
    },
  } as unknown as OpenCodeStreamClient;
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('inserts a line break before a streamed bold section title', async () => {
    const { thread, edits, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([textDelta('... type included.'), textDelta('**Optimizing message chunking**\n\nI’m considering a maximum...')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['... type included.']);
    expect(edits.at(-1)).toBe('... type included.\n\n**Optimizing message chunking**\n\nI’m considering a maximum...');
  });

  it('starts a separate Discord message for each assistant message ID', async () => {
    const { thread, edits, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([
      textDelta('First', 'part-1', 'session-1', 'msg-1'),
      textDelta(' response', 'part-1', 'session-1', 'msg-1'),
      textDelta('Second', 'part-2', 'session-1', 'msg-2'),
      textDelta(' answer', 'part-2', 'session-1', 'msg-2'),
    ])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['First', 'Second']);
    expect(edits).toEqual(['First response', 'Second answer']);
  });

  it('consumes SDK SSE result streams returned by global.event', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createSseResultClient([stream([textDelta('from sdk stream')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['from sdk stream']);
  });

  it('streams text deltas from SDK properties payloads', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'session-1', messageID: 'msg-1', partID: 'part-1', field: 'text', delta: 'agent response' },
          } as unknown as GlobalEventLike['payload'],
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['agent response']);
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

  it('stops Discord typing for the previous pump when subscribing a thread again', async () => {
    vi.useFakeTimers();
    const { thread, typing } = createThread();
    const handler = createHandler({}, thread);
    const firstStream = streamThenNever([textDelta('first')]);
    const secondStream = streamThenNever([textDelta('second')]);
    const firstClient = createClient([firstStream.iterable]);
    const secondClient = createClient([secondStream.iterable]);

    await handler.subscribe('thread-1', 'session-1', firstClient);
    await firstStream.drained;
    await handler.subscribe('thread-1', 'session-1', secondClient);
    await secondStream.drained;
    handler.unsubscribe('thread-1');
    await vi.advanceTimersByTimeAsync(9_000);

    expect(typing).toHaveBeenCalledTimes(2);
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

  it('escapes inline triple backticks in streamed prose', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([stream([textDelta('Mention ``` inline without starting a code block.')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['Mention `\u200b`` inline without starting a code block.']);
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

    expect(edits.at(-1)).toContain('-# Running: bash');
  });

  it('prints todos once from the first todo update event', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'todo.updated',
            sessionID: 'session-1',
            todos: [
              { content: 'Write tests', status: 'completed', priority: 'high' },
              { content: 'Implement renderer', status: 'in_progress', priority: 'high' },
              { content: 'Verify output', status: 'pending', priority: 'medium' },
            ],
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Todos\n> - Write tests\n> - Implement renderer\n> - Verify output']);
  });

  it('ignores later todo update events while streaming', async () => {
    const { thread, sends, edits } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'todo.updated',
            sessionID: 'session-1',
            todos: [{ content: 'Write tests', status: 'in_progress', priority: 'high' }],
          },
        },
        {
          directory: '/repo',
          payload: {
            type: 'todo.updated',
            sessionID: 'session-1',
            todos: [{ content: 'Write tests', status: 'completed', priority: 'high' }],
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Todos\n> - Write tests']);
    expect(edits).toEqual([]);
  });

  it('suppresses completed todo tool JSON output after printing the first todo list', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'todo.updated',
            sessionID: 'session-1',
            todos: [{ content: 'Write tests', status: 'in_progress', priority: 'high' }],
          },
        },
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'todowrite',
              state: {
                status: 'completed',
                input: {},
                title: 'Todos',
                output: '[{"content":"Write tests","status":"completed","priority":"high"}]',
              },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Todos\n> - Write tests']);
  });

  it('renders completed terminal tool output as a one-line summary', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', input: {}, title: 'Task: bash', output: 'pnpm test\n\nPASS streamHandler.test.ts' },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Bash completed · pnpm test']);
  });

  it('does not duplicate completed tool output when title and output are identical', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const summary = 'Success. Updated the following files:\nM src/discord/commands/cat.ts\nM src/discord/commands/diff.ts\nM src/discord/commands/git.ts';
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'apply_patch',
              state: { status: 'completed', input: {}, title: summary, output: summary },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Patch completed · 3 files updated · cat.ts, diff.ts, git.ts']);
  });

  it('renders search result dumps as a one-line summary', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const output = 'Found 196 matches (showing first 100)\n/Users/joaoleite/Developer/opencode-discord/src/discord/commands/diff.ts:\n  Line 32:       await interaction.editReply({ content: \'No file changes in this session.\' });\n\n/Users/joaoleite/Developer/opencode-discord/src/discord/commands/git.ts:\n  Line 21:   edit(options: unknown): Promise<unknown>;\n\n/Users/joaoleite/Developer/opencode-discord/src/discord/commands/cat.test.ts:\n  Line 53:     expect(interaction.reply).toHaveBeenCalledWith(...)';
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'grep',
              state: { status: 'completed', input: { pattern: 'tool|result|part' }, title: 'Task: grep', output },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Search completed · 196 matches · 100 shown · diff.ts, git.ts, cat.test.ts']);
  });

  it('renders failed tool output as a one-line summary', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'bash',
              state: { status: 'error', input: { command: 'pnpm test' }, title: 'Task: bash', error: 'Command failed with exit code 1\nFAIL streamHandler.test.ts' },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Bash failed · pnpm test']);
  });

  it('renders completed skill tool parts without verbose output', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'skill',
              state: {
                status: 'completed',
                input: { name: 'test-driven-development' },
                title: '-> Skill test-driven-development',
                output: '<skill_content name="test-driven-development">\nlong instructions\n</skill_content>',
              },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> -> Skill test-driven-development']);
  });

  it('truncates long completed terminal tool output to one Discord message', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', input: {}, title: 'Task: bash', output: 'a'.repeat(5000) },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Bash completed']);
  });

  it('renders completed read tool parts without file contents', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: '/repo/src/index.ts' },
                title: 'Read: /repo/src/index.ts',
                output: '1: const huge = true;\n2: '.concat('file contents\n'.repeat(200)),
              },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> Read: /repo/src/index.ts']);
  });

  it('renders structured directory tool output as a single summary line', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: '../configs' },
                title: 'Read: ../configs',
                output: '../configs <path>/Users/joaoleite/Developer/configs</path> <type>directory</type> <entries> .DS_Store .git/ .opencode/ AGENTS.md helpers/ install.sh modules/ opencode.json profiles/  (9 entries) </entries>',
              },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> **Read directory:** `/Users/joaoleite/Developer/configs` · 9 entries']);
  });

  it('renders structured file tool output as a single omitted-content line', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([
      stream([
        {
          directory: '/repo',
          payload: {
            type: 'message.part.updated',
            sessionID: 'session-1',
            messageID: 'msg-1',
            part: {
              id: 'tool-1',
              type: 'tool',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: '/repo/src/index.ts' },
                title: 'Read: /repo/src/index.ts',
                output: '<path>/repo/src/index.ts</path>\n<type>file</type>\n<content>1: const huge = true;\n2: file contents\n</content>',
              },
            },
          },
        },
      ]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(sends).toEqual(['> **Read file:** `/repo/src/index.ts` · content omitted']);
  });

  it('clears running tool status and stops typing when the session reports an error', async () => {
    vi.useFakeTimers();
    const { thread, edits, typing } = createThread();
    const handler = createHandler({}, thread);
    const persistent = streamThenNever([
      textDelta('Working'),
      {
        directory: '/repo',
        payload: {
          type: 'message.part.updated',
          sessionID: 'session-1',
          part: { id: 'tool-1', type: 'tool', tool: 'task', state: { status: 'running' } },
        },
      },
      { directory: '/repo', payload: { type: 'session.error', sessionID: 'session-1', error: { message: 'aborted' } } },
    ]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;
    await vi.advanceTimersByTimeAsync(9_000);
    handler.unsubscribe('thread-1');

    expect(edits).toContain('Working');
    expect(edits.at(-1)).not.toContain('Running: task');
    expect(typing).toHaveBeenCalledTimes(1);
  });

  it('clears running tool status and stops typing when session status becomes idle', async () => {
    vi.useFakeTimers();
    const { thread, edits, typing } = createThread();
    const handler = createHandler({}, thread);
    const persistent = streamThenNever([
      textDelta('Working'),
      {
        directory: '/repo',
        payload: {
          type: 'message.part.updated',
          sessionID: 'session-1',
          part: { id: 'tool-1', type: 'tool', tool: 'task', state: { status: 'running' } },
        },
      },
      { directory: '/repo', payload: { type: 'session.status', sessionID: 'session-1', status: 'idle' } },
    ]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;
    await vi.advanceTimersByTimeAsync(9_000);
    handler.unsubscribe('thread-1');

    expect(edits).toContain('Working');
    expect(edits.at(-1)).not.toContain('Running: task');
    expect(typing).toHaveBeenCalledTimes(1);
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

  it('keeps Discord typing active while matching stream activity is in progress', async () => {
    vi.useFakeTimers();
    const { thread, typing } = createThread();
    const handler = createHandler({}, thread);
    const persistent = streamThenNever([textDelta('A')]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;

    expect(typing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_000);

    expect(typing).toHaveBeenCalledTimes(2);

    handler.unsubscribe('thread-1');
    await vi.advanceTimersByTimeAsync(9_000);

    expect(typing).toHaveBeenCalledTimes(2);
  });

  it('does not start Discord typing until matching stream activity arrives', async () => {
    vi.useFakeTimers();
    const { thread, typing } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient([neverEndingStream()]);

    await handler.subscribe('thread-1', 'session-1', client);
    await vi.advanceTimersByTimeAsync(9_000);
    handler.unsubscribe('thread-1');

    expect(typing).not.toHaveBeenCalled();
  });

  it('continues streaming when refreshing Discord typing fails', async () => {
    const { thread, sends, typing } = createThread();
    typing.mockRejectedValueOnce(new Error('typing unavailable'));
    const handler = createHandler({}, thread);
    const client = createClient([stream([textDelta('response')])]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(typing).toHaveBeenCalledTimes(1);
    expect(sends).toEqual(['response']);
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

  it('flushes throttled content when the session becomes idle on a persistent stream', async () => {
    const { thread, edits } = createThread();
    const times = [0, 100, 200];
    const handler = createHandler({ editThrottleMs: 1000, now: () => times.shift() ?? 200 }, thread);
    const persistent = streamThenNever([
      textDelta('A'),
      textDelta('B'),
      { directory: '/repo', payload: { type: 'session.idle', sessionID: 'session-1' } },
    ]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;
    handler.unsubscribe('thread-1');

    expect(edits.at(-1)).toBe('AB');
  });

  it('stops Discord typing when the session becomes idle on a persistent stream', async () => {
    vi.useFakeTimers();
    const { thread, typing } = createThread();
    const handler = createHandler({}, thread);
    const persistent = streamThenNever([
      textDelta('A'),
      { directory: '/repo', payload: { type: 'session.idle', sessionID: 'session-1' } },
    ]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;
    await vi.advanceTimersByTimeAsync(9_000);
    handler.unsubscribe('thread-1');

    expect(typing).toHaveBeenCalledTimes(1);
  });

  it('restarts Discord typing when new text arrives after an idle event', async () => {
    vi.useFakeTimers();
    const { thread, typing } = createThread();
    const handler = createHandler({}, thread);
    const persistent = streamThenNever([
      textDelta('A'),
      { directory: '/repo', payload: { type: 'session.idle', sessionID: 'session-1' } },
      textDelta('B'),
    ]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;
    await vi.advanceTimersByTimeAsync(9_000);
    handler.unsubscribe('thread-1');

    expect(typing).toHaveBeenCalledTimes(3);
  });

  it('ignores repeated deltas for a message that already became idle', async () => {
    vi.useFakeTimers();
    const { thread, typing, sends, edits } = createThread();
    const handler = createHandler({}, thread);
    const persistent = streamThenNever([
      textDelta('A', 'part-1', 'session-1', 'message-1'),
      { directory: '/repo', payload: { type: 'session.idle', sessionID: 'session-1' } },
      textDelta('A', 'part-1', 'session-1', 'message-1'),
    ]);
    const client = createClient([persistent.iterable]);

    await handler.subscribe('thread-1', 'session-1', client);
    await persistent.drained;
    await vi.advanceTimersByTimeAsync(9_000);
    handler.unsubscribe('thread-1');

    expect(sends).toEqual(['A']);
    expect(edits).toEqual([]);
    expect(typing).toHaveBeenCalledTimes(1);
  });

  it('retries when an SSE stream ends cleanly and consumes the next stream', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({ maxRetries: 1 }, thread);
    const client = createClient([
      stream([]),
      stream([textDelta('after reconnect')]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(client.global.event).toHaveBeenCalledTimes(2);
    expect(sends).toContain('after reconnect');
  });

  it('resets retry failures after a successful reconnect stream', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({ maxRetries: 1 }, thread);
    const client = createClient([
      failingStream(new Error('first disconnect')),
      {
        async *[Symbol.asyncIterator]() {
          yield textDelta('recovered');
          throw new Error('second disconnect');
        },
      },
      stream([textDelta(' again')]),
    ]);

    await handler.subscribe('thread-1', 'session-1', client);
    await handler.waitForIdle('thread-1');

    expect(client.global.event).toHaveBeenCalledTimes(3);
    expect(sends).toContain('recovered');
    expect(sends.at(-1)).not.toContain('Stream disconnected after 1 retries.');
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
