import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { formatCodeBlockMessage, splitCodeBlockMessages } from '../../utils/formatter.js';

interface CommandContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
type ExecResult = { stdout: string; stderr: string };
type ComponentInteractionLike = { customId: string; user?: { id: string }; reply(options: unknown): Promise<unknown>; update(options: unknown): Promise<unknown> };
interface ComponentCollectorLike {
  on(event: 'collect', listener: (interaction: ComponentInteractionLike) => Promise<void>): void;
  on(event: 'end', listener: (collected: unknown, reason: string) => Promise<void>): void;
}
interface MessageWithCollector {
  createMessageComponentCollector(options: { time: number }): ComponentCollectorLike;
  edit(options: unknown): Promise<unknown>;
}

const MAX_ERROR_DETAILS_LENGTH = 1600;
const MAX_INLINE_DIFF_LENGTH = 10_000;

/** Dependencies for the /git command handler. */
export interface GitCommandDependencies {
  execFile(file: string, args: string[], options: { cwd: string }): Promise<ExecResult>;
  createAttachment(content: string, name: string): unknown;
}

const execFileAsync = promisify(nodeExecFile) as (file: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;
const defaultDeps: GitCommandDependencies = {
  execFile: execFileAsync,
  createAttachment: (content, name) => new AttachmentBuilder(Buffer.from(content), { name }),
};

/**
 * Create a handler for project-local git helper commands.
 * @param deps - Git execution dependency.
 * @returns Discord command handler.
 */
export function createGitCommandHandler(deps: GitCommandDependencies = defaultDeps): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const projectPath = channelConfig.projectPath;
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'reset' && interaction.options.getString('target', true) === 'hard') {
      await confirmResetHard(interaction, deps, projectPath);
      return;
    }

    await interaction.deferReply();
    const args = subcommand === 'checkout'
      ? await buildCheckoutArgs(interaction, deps, projectPath)
      : buildGitArgs(interaction, group, subcommand);
    const result = await runGit(deps, projectPath, args);
    const fallback = group === 'stash' && subcommand === 'list' ? 'No stashes.' : 'No output.';
    if (subcommand === 'diff') {
      const diff = (result.stdout || result.stderr).trimEnd() || fallback;
      if (diff.length > MAX_INLINE_DIFF_LENGTH) {
        await sendLargeDiffSummary(interaction, deps, projectPath, args);
        return;
      }

      await sendSplitEditReply(interaction, splitCodeBlockMessages(diff, 'diff'));
      return;
    }

    await interaction.editReply({ content: formatGitOutput(result.stdout || result.stderr, subcommand === 'diff' ? 'diff' : '', fallback) });
  };
}

async function sendSplitEditReply(interaction: ChatInputCommandInteraction, messages: string[]): Promise<void> {
  const [first = '```\n\n```', ...rest] = messages;
  await interaction.editReply({ content: first });
  for (const content of rest) {
    await interaction.followUp({ content });
  }
}

async function sendLargeDiffSummary(interaction: ChatInputCommandInteraction, deps: GitCommandDependencies, cwd: string, diffArgs: string[]): Promise<void> {
  const statArgs = [...diffArgs.slice(0, 1), '--numstat', ...diffArgs.slice(1)];
  const result = await runGit(deps, cwd, statArgs);
  const summary = formatDiffNumstat(result.stdout.trimEnd());
  await interaction.editReply({ content: `Diff is too large to display inline. Re-run \`/git diff file:<path>\` to inspect one file.\n${formatCodeBlockMessage(summary, '')}` });
}

function formatDiffNumstat(output: string): string {
  if (!output) {
    return 'No file changes.';
  }

  return output
    .split('\n')
    .map((line) => {
      const [additions = '-', deletions = '-', file = ''] = line.split('\t');
      return `+${additions} -${deletions} ${file}`.trimEnd();
    })
    .join('\n');
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
}

async function runGit(deps: GitCommandDependencies, cwd: string, args: string[]): Promise<ExecResult> {
  let result: ExecResult;
  try {
    result = await deps.execFile('git', args, { cwd });
  } catch (error) {
    throw mapGitError(error);
  }
  if (result.stderr.includes('CONFLICT')) {
    throw new BotError(ErrorCode.GIT_CONFLICT, 'Git operation reported conflicts.', { stderr: result.stderr });
  }

  return result;
}

function mapGitError(error: unknown): BotError {
  if (error instanceof BotError) {
    return error;
  }

  const stderr = getErrorStderr(error);
  if (stderr.includes('CONFLICT')) {
    return new BotError(ErrorCode.GIT_CONFLICT, 'Git operation reported conflicts.', { stderr });
  }

  const details = stderr || getErrorMessage(error);
  return new BotError(ErrorCode.DISCORD_API_ERROR, formatGitErrorMessage(details), { stderr: details });
}

function formatGitErrorMessage(details: string): string {
  const trimmed = details.trim();
  if (!trimmed) {
    return 'Git command failed.';
  }

  return `Git command failed.\n${formatCodeBlockMessage(truncateGitErrorDetails(trimmed), '')}`;
}

function truncateGitErrorDetails(details: string): string {
  return details.length > MAX_ERROR_DETAILS_LENGTH ? `${details.slice(0, MAX_ERROR_DETAILS_LENGTH)}\n... truncated` : details;
}

function getErrorStderr(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildCheckoutArgs(interaction: ChatInputCommandInteraction, deps: GitCommandDependencies, cwd: string): Promise<string[]> {
  const status = await runGit(deps, cwd, ['status', '--porcelain']);
  if (status.stdout.trim()) {
    throw new BotError(ErrorCode.GIT_DIRTY, 'Refusing to checkout with uncommitted changes.');
  }

  const branch = interaction.options.getString('branch', true);
  return interaction.options.getBoolean('create') ? ['checkout', '-b', branch] : ['checkout', branch];
}

function buildGitArgs(interaction: ChatInputCommandInteraction, group: string | null, subcommand: string): string[] {
  if (group === 'stash') {
    return buildStashArgs(interaction, subcommand);
  }

  switch (subcommand) {
    case 'status':
      return ['status', '--short'];
    case 'log':
      return ['log', `-${interaction.options.getInteger('count') ?? 10}`, '--oneline'];
    case 'diff':
      return buildDiffArgs(interaction);
    case 'branch':
      return ['branch', '--show-current'];
    case 'branches':
      return ['branch'];
    case 'reset':
      return ['reset', 'HEAD'];
    default:
      throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported git subcommand: ${subcommand}`);
  }
}

function buildStashArgs(interaction: ChatInputCommandInteraction, subcommand: string): string[] {
  if (subcommand === 'save') {
    const message = interaction.options.getString('message');
    return message ? ['stash', 'push', '-m', message] : ['stash', 'push'];
  }

  if (subcommand === 'pop') {
    return ['stash', 'pop'];
  }

  if (subcommand === 'list') {
    return ['stash', 'list'];
  }

  throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unsupported git stash subcommand: ${subcommand}`);
}

function buildDiffArgs(interaction: ChatInputCommandInteraction): string[] {
  const args = ['diff'];
  if (interaction.options.getBoolean('stat')) {
    args.push('--stat');
  }

  const target = interaction.options.getString('target') ?? 'unstaged';
  if (target === 'staged') {
    args.push('--cached');
  }
  if (target === 'branch') {
    args.push(interaction.options.getString('base') ?? 'main');
  }

  const file = interaction.options.getString('file');
  if (file) {
    args.push('--', file);
  }

  return args;
}

function formatGitOutput(output: string, language: string, fallback = 'No output.'): string {
  const trimmed = output.trimEnd() || fallback;
  const body = trimmed.length > 1800 ? `${trimmed.slice(0, 1800)}\n... truncated` : trimmed;
  return formatCodeBlockMessage(body, language);
}

async function confirmResetHard(interaction: ChatInputCommandInteraction, deps: GitCommandDependencies, cwd: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('git-reset-hard-confirm').setLabel('Reset hard').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('git-reset-hard-cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const message = await interaction.reply({ content: 'Confirm `git reset --hard`?', components: [row], fetchReply: true });
  const collectorMessage = message as unknown as Partial<MessageWithCollector>;
  const collector = collectorMessage.createMessageComponentCollector?.({ time: 30_000 });

  collector?.on('collect', async (componentInteraction) => {
    if (componentInteraction.user?.id !== interaction.user.id) {
      await componentInteraction.reply({ content: 'Only the user who requested this reset can confirm it.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (componentInteraction.customId !== 'git-reset-hard-confirm') {
      await componentInteraction.update({ content: 'Reset cancelled.', components: [] });
      return;
    }

    await runGit(deps, cwd, ['reset', '--hard']);
    await componentInteraction.update({ content: 'Hard reset complete.', components: [] });
  });
  collector?.on('end', async (_collected, reason) => {
    if (reason === 'time' && collectorMessage.edit) {
      await collectorMessage.edit({ content: 'Reset confirmation expired.', components: [] });
    }
  });
}
