---
name: discord-patterns
description: discord.js v14 patterns for threads, slash commands with autocomplete, embeds, button interactions, message editing for streaming, attachments, and typing indicators
---

## Client Setup

```ts
import { Client, GatewayIntentBits, Partials } from "discord.js"

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})
```

## Thread Creation

```ts
const thread = await channel.threads.create({
  name: threadName.slice(0, 100), // max 100 chars
  autoArchiveDuration: 1440,      // 24h
  reason: "OpenCode session",
})
await thread.send("Session started.")
```

## Slash Commands (Registration)

```ts
import { SlashCommandBuilder } from "discord.js"

const command = new SlashCommandBuilder()
  .setName("new")
  .setDescription("Create a new agent session")
  .addStringOption(opt =>
    opt.setName("prompt").setDescription("First message").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("agent").setDescription("Agent to use").setAutocomplete(true)
  )
```

## Autocomplete (respond within 3 seconds)

```ts
if (interaction.isAutocomplete()) {
  const focused = interaction.options.getFocused(true)
  const choices = getMatchingChoices(focused.value) // max 25
  await interaction.respond(
    choices.map(c => ({ name: c.label, value: c.id }))
  )
}
```

## Slash Command Execution

```ts
if (interaction.isChatInputCommand()) {
  await interaction.deferReply() // for long operations
  // ... do work ...
  await interaction.editReply({ content: "Done." })
}

// Ephemeral reply (only visible to user):
await interaction.reply({ content: "Error message", ephemeral: true })
```

## Embeds

```ts
import { EmbedBuilder } from "discord.js"

const embed = new EmbedBuilder()
  .setTitle("Session Info")
  .setColor(0x5865f2) // Discord blurple
  .addFields(
    { name: "Agent", value: agentName, inline: true },
    { name: "Model", value: modelId, inline: true },
  )
  .setFooter({ text: `Session: ${sessionId}` })
// Max 6000 chars total across all fields
```

## Buttons with Collector

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js"

const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId("confirm").setLabel("Confirm").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
)

const msg = await interaction.reply({ components: [row], fetchReply: true })

const collector = msg.createMessageComponentCollector({ time: 30_000 })
collector.on("collect", async (i) => {
  if (i.customId === "confirm") {
    await i.update({ content: "Confirmed.", components: [] })
  } else {
    await i.update({ content: "Cancelled.", components: [] })
  }
})
collector.on("end", (collected, reason) => {
  if (reason === "time") msg.edit({ content: "Timed out.", components: [] })
})
```

## Message Editing (for streaming)

```ts
// Create initial message
const msg = await thread.send("▍")

// Edit as tokens arrive (throttle to ~1/s to avoid rate limits)
await msg.edit(accumulatedContent)

// On 429 rate limit or edit failure: fall back to new message
```

Key constraints:
- Rate limit: ~5 edits per 5 seconds per message
- Max message length: 2000 chars
- If approaching limit: finalize current message, create new one

## Attachments

```ts
import { AttachmentBuilder } from "discord.js"

// From buffer (e.g. rendered PNG)
const attachment = new AttachmentBuilder(pngBuffer, { name: "table.png" })
await thread.send({ files: [attachment] })

// Download from URL first (Discord attachment URLs expire)
const res = await fetch(url)
const buffer = Buffer.from(await res.arrayBuffer())
```

## Typing Indicator

```ts
await channel.sendTyping() // shows "Bot is typing..." for 10 seconds
// Must be refreshed every 10s if still processing
const typingInterval = setInterval(() => channel.sendTyping(), 9000)
// Clear when done: clearInterval(typingInterval)
```

## Thread Archive/Unarchive

```ts
await thread.setArchived(true)  // Archive
await thread.setArchived(false) // Unarchive

// Detect thread events
client.on("threadDelete", (thread) => { /* cleanup */ })
client.on("threadUpdate", (oldThread, newThread) => {
  if (!oldThread.archived && newThread.archived) { /* user archived */ }
})
```

## Command Deployment to Specific Guilds

```ts
import { REST, Routes } from "discord.js"

const rest = new REST().setToken(token)
await rest.put(
  Routes.applicationGuildCommands(clientId, guildId),
  { body: commands.map(c => c.toJSON()) }
)
```
