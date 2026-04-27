import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Creates a Discord client configured for guild message handling.
 *
 * @param token - Discord bot token accepted by the factory for caller configuration.
 * @returns A configured Discord.js client instance.
 */
export function createDiscordClient(token: string): Client {
  void token;

  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.ThreadMember],
  });
}
