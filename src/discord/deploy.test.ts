import { REST, SlashCommandBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandDefinitions } from './commands/index.js';
import { deployCommands } from './deploy.js';
import { BotError, ErrorCode } from '../utils/errors.js';

const putMock = vi.fn();
const setTokenMock = vi.fn(() => ({ put: putMock }));

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();

  return {
    ...actual,
    REST: vi.fn(function MockRest() {
      return { setToken: setTokenMock };
    }),
  };
});

describe('getCommandDefinitions', () => {
  it('returns SlashCommandBuilder instances for all registered commands', () => {
    const commands = getCommandDefinitions();

    expect(commands).toHaveLength(24);
    expect(commands.every((command) => command instanceof SlashCommandBuilder)).toBe(true);
    expect(commands.map((command) => command.name)).toEqual([
      'new',
      'connect',
      'agent',
      'model',
      'interrupt',
      'queue',
      'info',
      'end',
      'status',
      'help',
      'git',
      'ls',
      'cat',
      'download',
      'restart',
      'mcp',
      'diff',
      'revert',
      'unrevert',
      'summary',
      'fork',
      'todo',
      'retry',
      'context',
    ]);
  });

  it('defines representative options, choices, and autocomplete flags', () => {
    const commandJson = getCommandDefinitions().map((command) => command.toJSON());

    const newCommand = commandJson.find((command) => command.name === 'new');
    expect(newCommand?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'prompt', type: 3, required: true }),
        expect.objectContaining({ name: 'agent', type: 3, autocomplete: true }),
        expect.objectContaining({ name: 'title', type: 3 }),
      ]),
    );

    const gitCommand = commandJson.find((command) => command.name === 'git');
    const gitDiff = gitCommand?.options?.find((option) => option.name === 'diff');
    const gitCheckout = gitCommand?.options?.find((option) => option.name === 'checkout');
    const gitStash = gitCommand?.options?.find((option) => option.name === 'stash');
    expect(gitDiff).toEqual(
      expect.objectContaining({
        name: 'diff',
        options: expect.arrayContaining([
          expect.objectContaining({
            name: 'target',
            choices: [
              { name: 'unstaged', value: 'unstaged' },
              { name: 'staged', value: 'staged' },
              { name: 'branch', value: 'branch' },
            ],
          }),
          expect.objectContaining({ name: 'stat', type: 5 }),
        ]),
      }),
    );
    expect(gitCheckout).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ name: 'branch', required: true, autocomplete: true }),
          expect.objectContaining({ name: 'create', type: 5 }),
        ]),
      }),
    );
    expect(gitStash).toEqual(
      expect.objectContaining({
        name: 'stash',
        options: expect.arrayContaining([
          expect.objectContaining({ name: 'save' }),
          expect.objectContaining({ name: 'pop' }),
          expect.objectContaining({ name: 'list' }),
        ]),
      }),
    );

    const contextCommand = commandJson.find((command) => command.name === 'context');
    const contextAdd = contextCommand?.options?.find((option) => option.name === 'add');
    expect(contextAdd).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ name: 'file1', required: true, autocomplete: true }),
          expect.objectContaining({ name: 'file5', autocomplete: true }),
        ]),
      }),
    );
  });
});

describe('deployCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putMock.mockResolvedValue(undefined);
  });

  it('registers command JSON with the guild command REST route', async () => {
    const token = `${Buffer.from('123456789012345678').toString('base64url')}.token.signature`;
    const commands = [
      new SlashCommandBuilder().setName('ping').setDescription('Ping command'),
    ];

    await deployCommands(token, 'guild-456', commands);

    expect(REST).toHaveBeenCalledWith({ version: '10' });
    expect(setTokenMock).toHaveBeenCalledWith(token);
    expect(putMock).toHaveBeenCalledWith(
      expect.stringContaining('/applications/123456789012345678/guilds/guild-456/commands'),
      { body: commands.map((command) => command.toJSON()) },
    );
  });

  it('throws a BotError for a non-empty token segment that decodes to a non-snowflake application ID', async () => {
    const token = `${Buffer.from('not-a-snowflake').toString('base64url')}.token.signature`;

    await expect(deployCommands(token, 'guild-456', [])).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    } satisfies Partial<BotError>);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('throws a BotError when the application ID cannot be decoded from the token', async () => {
    await expect(deployCommands('', 'guild-456', [])).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    } satisfies Partial<BotError>);
  });
});
