import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionHandler } from './questionHandler.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import type { QuestionClient, QuestionHandlerOptions, QuestionThread } from './questionHandler.js';

interface SentPayload {
  embeds?: { title?: string; description?: string }[];
  content?: string;
}

function createThread(): { thread: QuestionThread; sends: SentPayload[] } {
  const sends: SentPayload[] = [];
  const thread: QuestionThread = {
    send: vi.fn(async (payload: string | SentPayload) => {
      sends.push(typeof payload === 'string' ? { content: payload } : payload);
    }),
  };

  return { thread, sends };
}

function createClient(): QuestionClient {
  return {
    question: {
      reply: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
    },
  };
}

function createHandler(options: Partial<QuestionHandlerOptions> = {}, thread = createThread().thread): QuestionHandler {
  return new QuestionHandler({
    getThread: () => thread,
    timeoutMs: 60_000,
    ...options,
  });
}

describe('QuestionHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('posts an embed with lettered options for question events', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        type: 'question.asked',
        request: {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [
            {
              header: 'Proceed?',
              question: 'Should I continue?',
              options: [
                { label: 'Yes', description: 'Continue the task' },
                { label: 'No', description: 'Stop now' },
              ],
            },
          ],
        },
      },
      client,
    );

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(sends[0]?.embeds?.[0]?.title).toBe('Proceed?');
    expect(sends[0]?.embeds?.[0]?.description).toContain('Should I continue?');
    expect(sends[0]?.embeds?.[0]?.description).toContain('a) Yes - Continue the task');
    expect(sends[0]?.embeds?.[0]?.description).toContain('b) No - Stop now');
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
  });

  it('parses letter and text input while collecting multi-question answers sequentially', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Choose one',
            question: 'Pick an option',
            options: [
              { label: 'Yes', description: 'Approve' },
              { label: 'No', description: 'Decline' },
            ],
            custom: false,
          },
          {
            header: 'Reason',
            question: 'Why?',
            options: [],
            custom: true,
          },
        ],
      },
      client,
    );

    await handler.handleQuestionAnswer('thread-1', 'b');
    await handler.handleQuestionAnswer('thread-1', 'custom');

    expect(sends).toHaveLength(2);
    expect(sends[1]?.embeds?.[0]?.title).toBe('Reason');
    expect(client.question.reply).toHaveBeenCalledWith({ requestID: 'request-1', answers: [['No'], ['custom']] });
    expect(client.question.reject).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it('rejects and clears pending state when a question times out', async () => {
    vi.useFakeTimers();
    const { thread, sends } = createThread();
    const handler = createHandler({ timeoutMs: 100 }, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [{ header: 'Timeout?', question: 'Answer soon', options: [] }],
      },
      client,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'request-1' });
    expect(client.question.reply).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
    expect(sends.at(-1)?.content).toBe('Question timed out. The agent will continue without an answer.');
  });

  it('logs timeout failures instead of allowing unhandled timer rejections', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { thread } = createThread();
    const handler = createHandler({ timeoutMs: 100 }, thread);
    const client = createClient();
    vi.mocked(client.question.reject).mockRejectedValueOnce(new Error('network down'));

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [{ header: 'Timeout?', question: 'Answer soon', options: [] }],
      },
      client,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Question timeout handling failed');
  });

  it('re-shows the same question when input is invalid and custom answers are disabled', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Pick one',
            question: 'Choose',
            options: [{ label: 'Yes', description: 'Approve' }],
            custom: false,
          },
        ],
      },
      client,
    );

    await handler.handleQuestionAnswer('thread-1', 'z', 'corr-1');

    expect(client.question.reply).not.toHaveBeenCalled();
    expect(client.question.reject).not.toHaveBeenCalled();
    expect(sends).toHaveLength(3);
    expect(sends[1]?.content).toBe('Invalid answer. Please choose one of the listed options. *(ref: corr-1)*');
    expect(sends[2]?.embeds?.[0]?.title).toBe('Pick one');
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
  });

  it('rejects visibly when final question reply returns an SDK error envelope', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.question.reply).mockResolvedValueOnce({ error: { message: 'request expired' } });

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [{ header: 'Pick one', question: 'Choose', options: [{ label: 'Yes', description: 'Approve' }] }],
      },
      client,
    );

    await expect(handler.handleQuestionAnswer('thread-1', 'a')).rejects.toMatchObject({
      code: ErrorCode.QUESTION_INVALID_ANSWER,
      message: 'request expired',
    });
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
  });

  it('rejects visibly when missing-thread rejection returns an SDK error envelope', async () => {
    const handler = createHandler({ getThread: () => undefined });
    const client = createClient();
    vi.mocked(client.question.reject).mockResolvedValueOnce({ error: { message: 'request expired' } });

    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ header: 'Pick one', question: 'Choose', options: [] }],
        },
        client,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.QUESTION_TIMEOUT, message: 'request expired' });
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it.each([
    [{ multiple: false, custom: false }, 'Reply with a letter.'],
    [{ multiple: true, custom: false }, 'Reply with one or more letters (comma-separated).'],
    [{ multiple: false }, 'Reply with a letter, or type a custom answer.'],
    [{ multiple: true }, 'Reply with one or more letters (comma-separated), or type a custom answer.'],
  ])('renders instruction text for %j', async (settings, instruction) => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Pick',
            question: 'Choose',
            options: [{ label: 'Yes', description: 'Approve' }],
            ...settings,
          },
        ],
      },
      client,
    );

    expect(sends[0]?.embeds?.[0]?.description).toContain(instruction);
  });

  it('rejects unsupported questions with more than 26 options before posting', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    const options = Array.from({ length: 27 }, (_, index) => ({ label: `Option ${index + 1}`, description: 'Choice' }));

    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ header: 'Pick', question: 'Choose', options }],
        },
        client,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.QUESTION_INVALID_ANSWER });
    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-2',
          sessionID: 'session-1',
          questions: [{ header: 'Pick', question: 'Choose', options }],
        },
        client,
      ),
    ).rejects.toBeInstanceOf(BotError);
    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'request-1' });
    expect(thread.send).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });
});
