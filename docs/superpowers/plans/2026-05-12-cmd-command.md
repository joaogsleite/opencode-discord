# `/cmd` OpenCode Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/cmd` Discord command that lists and runs OpenCode custom commands, creating a session from a parent channel with the selected command's configured agent.

**Architecture:** Add a focused command module under `src/discord/commands/cmd.ts`, register it with the existing slash command registry, and wire it through `src/index.ts`. The handler calls OpenCode SDK v2 `command.list()` and `session.command()` directly, while reusing the existing `SessionBridge` for session creation and stream subscription.

**Tech Stack:** TypeScript, discord.js v14 slash commands, OpenCode SDK v2 structural clients, vitest.

---

## File Structure

- Create `src/discord/commands/cmd.ts`: `/cmd list` and `/cmd run` handler, command autocomplete helper, command formatting, thread creation, command-agent selection, and session command execution.
- Create `src/discord/commands/cmd.test.ts`: command-handler tests for listing, thread execution, channel-created execution with command agent, permission errors, and autocomplete.
- Modify `src/discord/commands/index.ts`: add `/cmd` command definition with `list` and `run` subcommands.
- Modify `src/discord/deploy.test.ts`: update command count/order and assert `/cmd` slash command JSON.
- Modify `src/index.ts`: import and register `createCmdCommandHandler`, and add autocomplete routing for `/cmd run name`.

## Task 1: Slash Command Registration

**Files:**
- Modify: `src/discord/deploy.test.ts`
- Modify: `src/discord/commands/index.ts`

- [ ] **Step 1: Write the failing registration test**

Update `src/discord/deploy.test.ts` so `getCommandDefinitions` expects 25 commands and includes `cmd` after `mcp`:

```ts
expect(commands).toHaveLength(25);
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
  'cmd',
  'diff',
  'revert',
  'unrevert',
  'summary',
  'fork',
  'todo',
  'retry',
  'context',
]);
```

Add an assertion in the representative options test:

```ts
const cmdCommand = commandJson.find((command) => command.name === 'cmd');
const cmdRun = cmdCommand?.options?.find((option) => option.name === 'run');
expect(cmdCommand?.options).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'list' })]));
expect(cmdRun).toEqual(expect.objectContaining({
  name: 'run',
  options: expect.arrayContaining([
    expect.objectContaining({ name: 'name', required: true, autocomplete: true }),
    expect.objectContaining({ name: 'prompt', required: true }),
  ]),
}));
```

- [ ] **Step 2: Run registration test to verify it fails**

Run: `pnpm vitest run src/discord/deploy.test.ts`

Expected: FAIL because `/cmd` is not registered and command count/order does not match.

- [ ] **Step 3: Add `/cmd` registration**

In `src/discord/commands/index.ts`, add this registry entry after `mcp`:

```ts
[
  'cmd',
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run OpenCode custom commands')
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List OpenCode custom commands'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('run')
        .setDescription('Run an OpenCode custom command')
        .addStringOption((option) =>
          option.setName('name').setDescription('Command to run').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((option) => option.setName('prompt').setDescription('Command prompt').setRequired(true)),
    ),
],
```

- [ ] **Step 4: Run registration test to verify it passes**

Run: `pnpm vitest run src/discord/deploy.test.ts`

Expected: PASS.

## Task 2: Command Handler Unit Tests

**Files:**
- Create: `src/discord/commands/cmd.test.ts`

- [ ] **Step 1: Write failing handler tests**

Create `src/discord/commands/cmd.test.ts` with tests for:

```ts
import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createCmdCommandHandler, getCmdAutocompleteChoices, type CmdCommandDependencies } from './cmd.js';

const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo', allowAgentSwitch: true, allowedAgents: ['build', 'review'] };
const session: SessionState = {
  sessionId: 'session-1',
  guildId: 'guild-1',
  channelId: 'channel-1',
  projectPath: '/repo',
  agent: 'build',
  model: null,
  createdBy: 'user-1',
  createdAt: 1000,
  lastActivityAt: 1000,
  status: 'active',
};

function createInteraction(subcommand: string, strings: Record<string, string> = {}, channel: unknown = { parentId: 'channel-1' }): ChatInputCommandInteraction {
  return {
    channelId: channel && typeof channel === 'object' && 'parentId' in channel ? 'thread-1' : 'channel-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    channel,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string, required?: boolean) => {
        const value = strings[name] ?? null;
        if (required && value === null) throw new Error(`Missing ${name}`);
        return value;
      }),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(commands = [{ name: 'review', description: 'Review code', agent: 'review', template: '', hints: [] }]): CmdCommandDependencies {
  const client = {
    command: { list: vi.fn(async () => commands) },
    session: { create: vi.fn(async () => ({ id: 'session-new' })), command: vi.fn(async () => ({})) },
  };
  return {
    stateManager: { getSession: vi.fn(() => session), setSession: vi.fn() },
    serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(() => client) },
    sessionBridge: { createSession: vi.fn(async () => ({ ...session, sessionId: 'session-new', agent: 'review' })) },
    rememberThread: vi.fn(),
  };
}

describe('createCmdCommandHandler', () => {
  it('lists OpenCode commands in an embed', async () => {
    const deps = createDeps();
    const interaction = createInteraction('list', {}, null);

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: 'OpenCode Commands', description: expect.stringContaining('review') }) })] }));
  });

  it('runs a command in an active session thread without overriding agent or model', async () => {
    const deps = createDeps();
    const interaction = createInteraction('run', { name: 'review', prompt: 'check this' });

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const client = deps.serverManager.getClient('/repo') as { session: { command: ReturnType<typeof vi.fn> } };
    expect(client.session.command).toHaveBeenCalledWith({ sessionID: 'session-1', command: 'review', arguments: 'check this' });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Running OpenCode command `review`.' });
  });

  it('creates a channel session with the selected command agent before running', async () => {
    const deps = createDeps();
    const thread = { id: 'thread-new', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const interaction = createInteraction('run', { name: 'review', prompt: 'check this' }, channel);

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-new', agent: 'review', title: 'review' }));
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('/cmd run review'));
  });

  it('falls back to the channel default agent when the command has no agent', async () => {
    const deps = createDeps([{ name: 'docs', description: 'Write docs', template: '', hints: [] }]);
    const thread = { id: 'thread-new', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const interaction = createInteraction('run', { name: 'docs', prompt: 'write docs' }, { threads: { create: vi.fn(async () => thread) } });

    await createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { ...channelConfig, defaultAgent: 'build' } });

    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'build' }));
  });

  it('rejects a command agent blocked by channel settings', async () => {
    const deps = createDeps([{ name: 'audit', agent: 'security', template: '', hints: [] }]);
    const interaction = createInteraction('run', { name: 'audit', prompt: 'scan' }, { threads: { create: vi.fn() } });

    await expect(createCmdCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_ALLOWED });
  });

  it('builds autocomplete choices from command names', () => {
    expect(getCmdAutocompleteChoices([{ name: 'review' }, { name: 'docs' }], 'rev')).toEqual([{ name: 'review', value: 'review' }]);
  });
});
```

- [ ] **Step 2: Run handler tests to verify they fail**

Run: `pnpm vitest run src/discord/commands/cmd.test.ts`

Expected: FAIL because `src/discord/commands/cmd.ts` does not exist.

## Task 3: Command Handler Implementation

**Files:**
- Create: `src/discord/commands/cmd.ts`

- [ ] **Step 1: Implement the minimal handler**

Create `src/discord/commands/cmd.ts` with:

```ts
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { checkAgentAllowed } from '../../utils/permissions.js';

interface InteractionContext { correlationId: string; channelConfig?: ChannelConfig }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;
interface OpencodeCommand { name: string; description?: string; agent?: string; template?: string; hints?: string[] }
interface CmdClient extends OpencodeSessionClient { command: { list(): Promise<unknown> }; session: OpencodeSessionClient['session'] & { command(options: { sessionID: string; command: string; arguments: string }): Promise<unknown> } }
interface ThreadLike { id: string; send(content: string): Promise<unknown>; members: { add(userId: string): Promise<unknown> } }
interface ThreadCreatableChannel { threads: { create(options: { name: string; autoArchiveDuration: number; reason: string }): Promise<ThreadLike> } }

/** Dependencies for the /cmd command handler. */
export interface CmdCommandDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined; setSession(threadId: string, session: SessionState): void };
  serverManager: { ensureRunning(projectPath: string): Promise<unknown>; getClient(projectPath: string): unknown | undefined };
  sessionBridge: Pick<SessionBridge, 'createSession'>;
  rememberThread?: (threadId: string, thread: ThreadLike) => void;
}

/**
 * Create a handler for listing and running OpenCode custom commands.
 * @param deps - State, server, and session dependencies.
 * @returns Discord command handler.
 */
export function createCmdCommandHandler(deps: CmdCommandDependencies): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'list') {
      await handleList(interaction, context, deps);
      return;
    }
    if (subcommand === 'run') {
      await handleRun(interaction, context, deps);
      return;
    }
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported cmd subcommand: ${subcommand}`);
  };
}

/**
 * Build command-name autocomplete choices.
 * @param commands - OpenCode command records.
 * @param focused - Current focused input.
 * @returns Discord autocomplete choices.
 */
export function getCmdAutocompleteChoices(commands: unknown[], focused = ''): Array<{ name: string; value: string }> {
  return commands
    .map(normalizeCommand)
    .filter((command): command is OpencodeCommand => command !== undefined)
    .filter((command) => command.name.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((command) => ({ name: command.name, value: command.name }));
}

async function handleList(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: CmdCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  await interaction.deferReply();
  const client = await ensureClient(deps, channelConfig.projectPath);
  await interaction.editReply({ embeds: [formatCommandList(await listCommands(client))] });
}

async function handleRun(interaction: ChatInputCommandInteraction, context: InteractionContext, deps: CmdCommandDependencies): Promise<void> {
  const channelConfig = requireChannelConfig(context);
  const name = interaction.options.getString('name', true);
  const prompt = interaction.options.getString('prompt', true);
  await interaction.deferReply();

  if (isThreadInteraction(interaction)) {
    const session = requireThreadSession(interaction, deps.stateManager);
    const client = requireClient(deps, session.projectPath);
    await runSessionCommand(client, session.sessionId, name, prompt);
    await interaction.editReply({ content: `Running OpenCode command \`${name}\`.` });
    return;
  }

  const client = await ensureClient(deps, channelConfig.projectPath);
  const command = requireCommand(await listCommands(client), name);
  const agent = command.agent ?? channelConfig.defaultAgent ?? 'build';
  assertAgentAllowed(channelConfig, agent);
  const thread = await createThread(interaction, name);
  await thread.members.add(interaction.user.id);
  deps.rememberThread?.(thread.id, thread);
  await thread.send(formatInitialCommand(name, prompt));
  const session = await deps.sessionBridge.createSession({
    client,
    threadId: thread.id,
    guildId: requireGuildId(interaction),
    channelId: interaction.channelId,
    projectPath: channelConfig.projectPath,
    agent,
    model: null,
    createdBy: interaction.user.id,
    title: normalizeTitle(name),
  });
  await runSessionCommand(client, session.sessionId, name, prompt);
  await interaction.editReply({ content: `Created OpenCode session in thread ${thread.id} and running command \`${name}\`.` });
}

async function ensureClient(deps: CmdCommandDependencies, projectPath: string): Promise<CmdClient> {
  return await deps.serverManager.ensureRunning(projectPath) as CmdClient;
}

function requireClient(deps: CmdCommandDependencies, projectPath: string): CmdClient {
  const client = deps.serverManager.getClient(projectPath) as CmdClient | undefined;
  if (!client) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  return client;
}

async function listCommands(client: CmdClient): Promise<OpencodeCommand[]> {
  const response = await client.command.list();
  const data = isRecord(response) && Array.isArray(response.data) ? response.data : response;
  return Array.isArray(data) ? data.map(normalizeCommand).filter((command): command is OpencodeCommand => command !== undefined) : [];
}

function normalizeCommand(value: unknown): OpencodeCommand | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined;
  return {
    name: value.name,
    description: typeof value.description === 'string' ? value.description : undefined,
    agent: typeof value.agent === 'string' && value.agent.length > 0 ? value.agent : undefined,
    template: typeof value.template === 'string' ? value.template : undefined,
    hints: Array.isArray(value.hints) ? value.hints.filter((hint): hint is string => typeof hint === 'string') : [],
  };
}

function requireCommand(commands: OpencodeCommand[], name: string): OpencodeCommand {
  const command = commands.find((item) => item.name === name);
  if (!command) throw new BotError(ErrorCode.DISCORD_API_ERROR, `OpenCode command not found: ${name}`, { command: name });
  return command;
}

function formatCommandList(commands: OpencodeCommand[]): EmbedBuilder {
  const description = boundDescription(commands.map((command) => `\`${command.name}\`${command.description ? ` - ${command.description}` : ''}`).join('\n') || 'No OpenCode commands available.');
  return new EmbedBuilder().setTitle('OpenCode Commands').setColor(0x5865f2).setDescription(description);
}

function boundDescription(value: string): string {
  const marker = '\n... truncated';
  return value.length <= 4096 ? value : `${value.slice(0, 4096 - marker.length)}${marker}`;
}

function requireChannelConfig(context: InteractionContext): ChannelConfig {
  if (!context.channelConfig) throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  return context.channelConfig;
}

function isThreadInteraction(interaction: ChatInputCommandInteraction): boolean {
  return Boolean((interaction.channel as { parentId?: string | null } | null)?.parentId);
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: CmdCommandDependencies['stateManager']): SessionState {
  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  return session;
}

function assertAgentAllowed(channelConfig: ChannelConfig, agent: string): void {
  const allowed = checkAgentAllowed(channelConfig, agent);
  if (allowed !== true) {
    throw new BotError(ErrorCode[allowed.reason], allowed.reason === 'AGENT_SWITCH_DISABLED'
      ? 'Agent switching is disabled for this channel.'
      : `Agent '${agent}' is not allowed in this channel.`, { agent });
  }
}

async function createThread(interaction: ChatInputCommandInteraction, name: string): Promise<ThreadLike> {
  const channel = interaction.channel as Partial<ThreadCreatableChannel> | null;
  if (!channel?.threads?.create) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only create sessions in a channel that supports threads.');
  return await channel.threads.create({ name: normalizeTitle(name), autoArchiveDuration: 1440, reason: 'OpenCode command session' });
}

function normalizeTitle(name: string): string {
  return name.trim().slice(0, 100) || 'OpenCode command';
}

function requireGuildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a server.');
  return interaction.guildId;
}

function formatInitialCommand(name: string, prompt: string): string {
  return `> **/cmd run ${name}:**\n${prompt.split('\n').map((line) => `> ${line}`).join('\n')}`;
}

async function runSessionCommand(client: CmdClient, sessionId: string, name: string, prompt: string): Promise<void> {
  const result = await client.session.command({ sessionID: sessionId, command: name, arguments: prompt });
  if (isRecord(result) && result.error) throw new BotError(ErrorCode.DISCORD_API_ERROR, 'OpenCode command failed', { sessionId, command: name, sdkError: result.error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
```

- [ ] **Step 2: Run handler tests to verify they pass**

Run: `pnpm vitest run src/discord/commands/cmd.test.ts`

Expected: PASS.

## Task 4: Runtime Wiring and Autocomplete

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts` if existing startup wiring tests assert command handler behavior

- [ ] **Step 1: Write failing runtime/autocomplete test if needed**

Search existing `src/index.test.ts` for command routing assertions. If the test already checks handler map indirectly, update it to include `/cmd` and add an autocomplete case for command name. The core expected autocomplete behavior is:

```ts
await interactionListener?.({
  id: 'interaction-1',
  channelId: 'channel-1',
  channel: null,
  guildId: 'guild-1',
  commandName: 'cmd',
  options: { getFocused: vi.fn(() => ({ name: 'name', value: 'rev' })), getSubcommand: vi.fn(() => 'run') },
  isChatInputCommand: () => false,
  isAutocomplete: () => true,
  respond,
});
expect(respond).toHaveBeenCalledWith([{ name: 'review', value: 'review' }]);
```

- [ ] **Step 2: Run affected runtime test to verify it fails**

Run: `pnpm vitest run src/index.test.ts`

Expected: FAIL if a new assertion was added, because `/cmd` is not wired yet.

- [ ] **Step 3: Wire `/cmd` in `src/index.ts`**

Add import:

```ts
import { createCmdCommandHandler, getCmdAutocompleteChoices } from './discord/commands/cmd.js';
```

Add command handler after `mcp`:

```ts
['cmd', createCmdCommandHandler({
  stateManager,
  serverManager: dependencies.serverManager,
  sessionBridge: dependencies.sessionBridge,
  rememberThread: dependencies.threadResolver.remember,
})],
```

Add autocomplete handling before the generic `message` handling:

```ts
if (focused.name === 'name' && interaction.commandName === 'cmd') {
  const client = dependencies.serverManager.getClient(channelConfig.projectPath);
  if (!isRecord(client) || !isRecord(client.command) || typeof client.command.list !== 'function') {
    return [];
  }
  try {
    const response = await client.command.list();
    const commands = isRecord(response) && Array.isArray(response.data) ? response.data : Array.isArray(response) ? response : [];
    return getCmdAutocompleteChoices(commands, value);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run runtime test to verify it passes**

Run: `pnpm vitest run src/index.test.ts`

Expected: PASS.

## Task 5: Full Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run typecheck and full test suite**

Run: `pnpm tsc --noEmit && pnpm test`

Expected: PASS.

- [ ] **Step 2: Fix any failures with the smallest correct change**

If typecheck or tests fail, inspect the error, adjust the touched files only, and rerun `pnpm tsc --noEmit && pnpm test`.

## Self-Review

- Spec coverage: `/cmd list`, `/cmd run`, thread execution, parent-channel session creation, command-agent selection, no command agent/model overrides, and autocomplete are all covered by tasks.
- Placeholder scan: no placeholders remain.
- Type consistency: `CmdCommandDependencies`, `CmdClient`, `OpencodeCommand`, and handler names are consistent across tasks.
