import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler.js';
import type {
  PermissionClient,
  PermissionCollector,
  PermissionHandlerOptions,
  PermissionInteraction,
  PermissionMessage,
  PermissionThread,
} from './permissionHandler.js';

interface SentPayload {
  embeds?: { title?: string; description?: string }[];
  components?: { components?: { customId?: string; label?: string }[] }[];
  content?: string;
}

type TestInteraction = PermissionInteraction & {
  update: (payload: { embeds?: unknown[]; components?: unknown[]; content?: string }) => Promise<unknown>;
};

class TestCollector implements PermissionCollector {
  private readonly collectHandlers: ((interaction: TestInteraction) => void | Promise<void>)[] = [];
  private readonly endHandlers: ((collected: unknown, reason: string) => void | Promise<void>)[] = [];
  public readonly stop = vi.fn((reason?: string) => {
    this.emitEnd(reason ?? 'user');
  });

  public on(event: 'collect', callback: (interaction: TestInteraction) => void | Promise<void>): PermissionCollector;
  public on(event: 'end', callback: (collected: unknown, reason: string) => void | Promise<void>): PermissionCollector;
  public on(event: 'collect' | 'end', callback: ((interaction: TestInteraction) => void | Promise<void>) | ((collected: unknown, reason: string) => void | Promise<void>)): PermissionCollector {
    if (event === 'collect') {
      this.collectHandlers.push(callback as (interaction: TestInteraction) => void | Promise<void>);
    } else {
      this.endHandlers.push(callback as (collected: unknown, reason: string) => void | Promise<void>);
    }

    return this;
  }

  public async emitCollect(customId: string): Promise<TestInteraction> {
    const interaction = { customId, update: vi.fn(async () => undefined) };
    for (const handler of this.collectHandlers) {
      await handler(interaction);
    }
    return interaction;
  }

  public async emitEnd(reason = 'time'): Promise<void> {
    for (const handler of this.endHandlers) {
      await handler([], reason);
    }
  }
}

function createClient(): PermissionClient {
  return {
    permission: {
      reply: vi.fn(async () => undefined),
    },
  };
}

function createThread(collector = new TestCollector()): { collector: TestCollector; sends: SentPayload[]; thread: PermissionThread } {
  const sends: SentPayload[] = [];
  const message: PermissionMessage = {
    createMessageComponentCollector: vi.fn(() => collector),
    edit: vi.fn(async (payload: SentPayload) => {
      sends.push(payload);
    }),
  };
  const thread: PermissionThread = {
    send: vi.fn(async (payload: string | SentPayload) => {
      sends.push(typeof payload === 'string' ? { content: payload } : payload);
      return message;
    }),
  };

  return { collector, sends, thread };
}

function createHandler(options: Partial<PermissionHandlerOptions> = {}, thread = createThread().thread): PermissionHandler {
  return new PermissionHandler({
    getThread: () => thread,
    getChannelConfig: () => ({ permissions: 'interactive' }),
    timeoutMs: 60_000,
    ...options,
  });
}

describe('PermissionHandler', () => {
  it('immediately replies always in auto mode without sending a Discord message', async () => {
    const { thread } = createThread();
    const handler = createHandler({ getChannelConfig: () => ({ permissions: 'auto' }) }, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['npm test'] },
      client,
    );

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'always' });
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('posts an embed with allow and reject buttons in interactive mode', async () => {
    const { sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      {
        type: 'permission.asked',
        request: { id: 'request-1', sessionID: 'session-1', permission: 'edit', patterns: ['src/**/*.ts'] },
      },
      client,
    );

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(sends[0]?.embeds?.[0]?.title).toBe('Permission Request');
    expect(sends[0]?.embeds?.[0]?.description).toContain('edit');
    expect(sends[0]?.embeds?.[0]?.description).toContain('src/**/*.ts');
    expect(sends[0]?.components?.[0]?.components).toEqual([
      expect.objectContaining({ customId: 'allow_once', label: 'Allow Once' }),
      expect.objectContaining({ customId: 'allow_always', label: 'Always' }),
      expect.objectContaining({ customId: 'reject', label: 'Reject' }),
    ]);
  });

  it.each([
    ['allow_once', 'once'],
    ['allow_always', 'always'],
    ['reject', 'reject'],
  ] as const)('replies %s button clicks as %s', async (customId, reply) => {
    const { collector, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const interaction = await collector.emitCollect(customId);

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply });
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(collector.stop).toHaveBeenCalledWith('answered');
  });

  it('rejects and posts a timeout notice when the collector times out', async () => {
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    await collector.emitEnd('time');

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'reject' });
    expect(sends.at(-1)?.content).toBe('Permission request timed out. The request was rejected.');
  });
});
