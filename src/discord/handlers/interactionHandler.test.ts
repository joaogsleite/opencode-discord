import type { ApplicationCommandOptionChoiceData, AutocompleteInteraction, ChatInputCommandInteraction, Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigLoader } from '../../config/loader.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { handleInteraction, type AutocompleteHandler, type CommandHandler } from './interactionHandler.js';

function createConfigLoader(channelConfig?: ChannelConfig): ConfigLoader {
  return {
    getChannelConfig: vi.fn(() => channelConfig),
  } as unknown as ConfigLoader;
}

function createCommandInteraction(commandName = 'new', userId = 'user-1'): ChatInputCommandInteraction {
  return {
    id: 'interaction-1',
    channelId: 'channel-1',
    guildId: 'guild-1',
    commandName,
    user: { id: userId },
    replied: false,
    deferred: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    reply: vi.fn(),
    followUp: vi.fn(),
    editReply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

function createAutocompleteInteraction(commandName = 'agent'): AutocompleteInteraction {
  return {
    id: 'interaction-2',
    channelId: 'channel-1',
    guildId: 'guild-1',
    commandName,
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    respond: vi.fn(),
  } as unknown as AutocompleteInteraction;
}

describe('handleInteraction', () => {
  it('dispatches command interactions to the registered command handler with context', async () => {
    const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/project' };
    const configLoader = createConfigLoader(channelConfig);
    const commandHandler = vi.fn<CommandHandler>();
    const interaction = createCommandInteraction('new');

    await handleInteraction(interaction, {
      configLoader,
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(configLoader.getChannelConfig).toHaveBeenCalledWith('guild-1', 'channel-1');
    expect(commandHandler).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        channelConfig,
        correlationId: expect.stringMatching(/^channel-1-\d+$/),
      }),
    );
  });

  it('responds to autocomplete interactions with returned choices', async () => {
    const choices: ApplicationCommandOptionChoiceData[] = [
      { name: 'agent-a', value: 'agent-a' },
      { name: 'agent-b', value: 'agent-b' },
    ];
    const autocompleteHandler = vi.fn<AutocompleteHandler>(async () => choices);
    const interaction = createAutocompleteInteraction();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map(),
      autocompleteHandler,
    });

    expect(autocompleteHandler).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({ correlationId: expect.stringMatching(/^channel-1-\d+$/) }),
    );
    expect(interaction.respond).toHaveBeenCalledWith(choices);
  });

  it('returns an ephemeral error for unknown commands', async () => {
    const interaction = createCommandInteraction('missing');
    const commandHandler = vi.fn<CommandHandler>();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/Unknown command.*ref: channel-1-\d+/),
      ephemeral: true,
    });
  });

  it('checks allowedUsers before executing command handlers', async () => {
    const channelConfig: ChannelConfig = {
      channelId: 'channel-1',
      projectPath: '/project',
      allowedUsers: ['allowed-user'],
    };
    const interaction = createCommandInteraction('new', 'blocked-user');
    const commandHandler = vi.fn<CommandHandler>();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(channelConfig),
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler: vi.fn<AutocompleteHandler>(),
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/not allowed.*ref: channel-1-\d+/i),
      ephemeral: true,
    });
  });

  it('responds with empty autocomplete choices when the autocomplete handler fails', async () => {
    const interaction = createAutocompleteInteraction();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map(),
      autocompleteHandler: vi.fn<AutocompleteHandler>(async () => {
        throw new BotError(ErrorCode.AGENT_NOT_FOUND, 'Agent cache failed');
      }),
    });

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('ignores interactions that are neither commands nor autocomplete', async () => {
    const interaction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
    } as unknown as Interaction;
    const commandHandler = vi.fn<CommandHandler>();
    const autocompleteHandler = vi.fn<AutocompleteHandler>();

    await handleInteraction(interaction, {
      configLoader: createConfigLoader(),
      commandHandlers: new Map([['new', commandHandler]]),
      autocompleteHandler,
    });

    expect(commandHandler).not.toHaveBeenCalled();
    expect(autocompleteHandler).not.toHaveBeenCalled();
  });
});
