import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { createTodoCommandHandler, type TodoCommandDependencies } from './todo.js';

function createSession(): SessionState {
  return { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'active' };
}

function createInteraction(): ChatInputCommandInteraction {
  return { channelId: 'thread-1', channel: { parentId: 'channel-1' }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
}

function createDeps(todos: unknown[] = [{ content: 'Write tests', status: 'pending' }, { content: 'Implement', status: 'in_progress' }, { content: 'Verify', status: 'completed' }]): TodoCommandDependencies {
  const client = { session: { todo: vi.fn(async () => todos) } };
  return { stateManager: { getSession: vi.fn(() => createSession()) }, serverManager: { getClient: vi.fn(() => client) } };
}

describe('createTodoCommandHandler', () => {
  it('renders session todos with status indicators', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createTodoCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const client = deps.serverManager.getClient('/repo') as { session: { todo: ReturnType<typeof vi.fn> } };
    expect(client.session.todo).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: 'Session Todos', description: expect.stringContaining('[ ] Write tests') }) })] });
  });

  it('defers before fetching todos from the SDK', async () => {
    const events: string[] = [];
    const client = { session: { todo: vi.fn(async () => { events.push('todo'); return []; }) } };
    const deps: TodoCommandDependencies = { stateManager: { getSession: vi.fn(() => createSession()) }, serverManager: { getClient: vi.fn(() => client) } };
    const interaction = createInteraction();
    vi.mocked(interaction.deferReply).mockImplementation(async () => { events.push('deferReply'); return {} as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>; });

    await createTodoCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(events).toEqual(['deferReply', 'todo']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('renders hyphenated in-progress status as active', async () => {
    const deps = createDeps([{ content: 'Implement fix', status: 'in-progress' }]);
    const interaction = createInteraction();

    await createTodoCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [expect.objectContaining({ data: expect.objectContaining({ description: '[~] Implement fix' }) })] });
  });
});
