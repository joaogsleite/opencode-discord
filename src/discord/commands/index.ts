import {
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

type CommandDefinition = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

const commandRegistry = new Map<string, CommandDefinition>([
  [
    'new',
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Create a new OpenCode session')
      .addStringOption((option) =>
        option.setName('prompt').setDescription('Initial prompt').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('agent').setDescription('Agent to use').setAutocomplete(true),
      )
      .addStringOption((option) => option.setName('title').setDescription('Thread title')),
  ],
  [
    'connect',
    new SlashCommandBuilder()
      .setName('connect')
      .setDescription('Connect to an existing OpenCode session')
      .addStringOption((option) =>
        option.setName('session').setDescription('Session to connect').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((option) => option.setName('title').setDescription('Thread title')),
  ],
  [
    'agent',
    new SlashCommandBuilder()
      .setName('agent')
      .setDescription('Manage the active agent')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('Set the active agent')
          .addStringOption((option) =>
            option.setName('agent').setDescription('Agent to use').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List available agents')),
  ],
  [
    'model',
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Manage the active model')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('Set the active model')
          .addStringOption((option) =>
            option.setName('model').setDescription('Model to use').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List available models')),
  ],
  ['interrupt', new SlashCommandBuilder().setName('interrupt').setDescription('Interrupt the active session')],
  [
    'queue',
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Manage queued messages')
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List queued messages'))
      .addSubcommand((subcommand) => subcommand.setName('clear').setDescription('Clear queued messages')),
  ],
  ['info', new SlashCommandBuilder().setName('info').setDescription('Show session information')],
  ['end', new SlashCommandBuilder().setName('end').setDescription('End the active session')],
  ['status', new SlashCommandBuilder().setName('status').setDescription('Show bot status')],
  ['help', new SlashCommandBuilder().setName('help').setDescription('Show command help')],
  [
    'git',
    new SlashCommandBuilder()
      .setName('git')
      .setDescription('Run git helpers')
      .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Show git status'))
      .addSubcommand((subcommand) =>
        subcommand
          .setName('log')
          .setDescription('Show recent commits; defaults to recent history when count is omitted')
          .addIntegerOption((option) => option.setName('count').setDescription('Number of commits to show')),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('diff')
          .setDescription('Show git diff')
          .addStringOption((option) =>
            option
              .setName('target')
              .setDescription('Diff target')
              .addChoices(
                { name: 'unstaged', value: 'unstaged' },
                { name: 'staged', value: 'staged' },
                { name: 'branch', value: 'branch' },
              ),
          )
          .addStringOption((option) => option.setName('base').setDescription('Base branch or ref'))
          .addBooleanOption((option) => option.setName('stat').setDescription('Show diff stat only')),
      )
      .addSubcommand((subcommand) => subcommand.setName('branch').setDescription('Show current branch'))
      .addSubcommand((subcommand) => subcommand.setName('branches').setDescription('List branches'))
      .addSubcommand((subcommand) =>
        subcommand
          .setName('checkout')
          .setDescription('Checkout a branch')
          .addStringOption((option) =>
            option.setName('branch').setDescription('Branch to checkout').setRequired(true).setAutocomplete(true),
          )
          .addBooleanOption((option) => option.setName('create').setDescription('Create the branch')),
      )
      .addSubcommandGroup((group) =>
        group
          .setName('stash')
          .setDescription('Manage git stashes')
          .addSubcommand((subcommand) =>
            subcommand
              .setName('save')
              .setDescription('Save a stash')
              .addStringOption((option) => option.setName('message').setDescription('Stash message')),
          )
          .addSubcommand((subcommand) => subcommand.setName('pop').setDescription('Pop the latest stash'))
          .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List stashes')),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('reset')
          .setDescription('Reset git state')
          .addStringOption((option) =>
            option
              .setName('target')
              .setDescription('Reset target')
              .setRequired(true)
              .addChoices({ name: 'staged', value: 'staged' }, { name: 'hard', value: 'hard' }),
          ),
      ),
  ],
  [
    'ls',
    new SlashCommandBuilder()
      .setName('ls')
      .setDescription('List files')
      .addStringOption((option) => option.setName('path').setDescription('Path to list').setAutocomplete(true)),
  ],
  [
    'cat',
    new SlashCommandBuilder()
      .setName('cat')
      .setDescription('Show file contents')
      .addStringOption((option) =>
        option.setName('file').setDescription('File to show').setRequired(true).setAutocomplete(true),
      )
      .addIntegerOption((option) => option.setName('start').setDescription('Start line'))
      .addIntegerOption((option) => option.setName('end').setDescription('End line')),
  ],
  [
    'download',
    new SlashCommandBuilder()
      .setName('download')
      .setDescription('Download a file')
      .addStringOption((option) =>
        option.setName('file').setDescription('File to download').setRequired(true).setAutocomplete(true),
      ),
  ],
  ['restart', new SlashCommandBuilder().setName('restart').setDescription('Restart the OpenCode server')],
  [
    'mcp',
    new SlashCommandBuilder()
      .setName('mcp')
      .setDescription('Manage MCP connections')
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List MCP connections'))
      .addSubcommand((subcommand) =>
        subcommand
          .setName('reconnect')
          .setDescription('Reconnect an MCP server')
          .addStringOption((option) => option.setName('name').setDescription('MCP server name').setAutocomplete(true)),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('disconnect')
          .setDescription('Disconnect an MCP server')
          .addStringOption((option) =>
            option.setName('name').setDescription('MCP server name').setRequired(true).setAutocomplete(true),
          ),
      ),
  ],
  ['diff', new SlashCommandBuilder().setName('diff').setDescription('Show session diff')],
  [
    'revert',
    new SlashCommandBuilder()
      .setName('revert')
      .setDescription('Revert a message')
      .addStringOption((option) => option.setName('message').setDescription('Message to revert').setAutocomplete(true)),
  ],
  ['unrevert', new SlashCommandBuilder().setName('unrevert').setDescription('Undo the last revert')],
  [
    'summary',
    new SlashCommandBuilder()
      .setName('summary')
      .setDescription('Summarize the session')
      .addStringOption((option) => option.setName('model').setDescription('Model to use').setAutocomplete(true)),
  ],
  [
    'fork',
    new SlashCommandBuilder()
      .setName('fork')
      .setDescription('Fork the current session')
      .addStringOption((option) => option.setName('message').setDescription('Message to fork from').setAutocomplete(true))
      .addStringOption((option) => option.setName('title').setDescription('Fork title')),
  ],
  ['todo', new SlashCommandBuilder().setName('todo').setDescription('Show session todos')],
  ['retry', new SlashCommandBuilder().setName('retry').setDescription('Retry the last message')],
  [
    'context',
    new SlashCommandBuilder()
      .setName('context')
      .setDescription('Manage session context')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('add')
          .setDescription('Add files to context')
          .addStringOption((option) =>
            option.setName('file1').setDescription('File to add').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((option) => option.setName('file2').setDescription('File to add').setAutocomplete(true))
          .addStringOption((option) => option.setName('file3').setDescription('File to add').setAutocomplete(true))
          .addStringOption((option) => option.setName('file4').setDescription('File to add').setAutocomplete(true))
          .addStringOption((option) => option.setName('file5').setDescription('File to add').setAutocomplete(true)),
      )
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List context files'))
      .addSubcommand((subcommand) => subcommand.setName('clear').setDescription('Clear context files')),
  ],
]);

/**
 * Gets all slash command definitions in registration order.
 *
 * @returns Slash command builders for Discord registration.
 */
export function getCommandDefinitions(): SlashCommandBuilder[] {
  return [...commandRegistry.values()] as SlashCommandBuilder[];
}
