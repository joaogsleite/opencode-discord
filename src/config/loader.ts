import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, type ValidatedConfig } from './schema.js';
import type { ChannelConfig } from './types.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ConfigLoader');

/** Callback invoked after a config reload succeeds. */
export type ChangeCallback = (config: ValidatedConfig) => void;

/** Loads, validates, and exposes bot configuration from a YAML file. */
export class ConfigLoader {
  private config: ValidatedConfig | null = null;
  private readonly callbacks: ChangeCallback[] = [];

  /**
   * Create a config loader for a YAML file path.
   * @param configPath - Path to the YAML config file
   */
  public constructor(private readonly configPath: string) {}

  /**
   * Load and validate the config file.
   * @returns Nothing
   * @throws BotError with CONFIG_INVALID if reading, YAML parsing, or validation fails
   */
  public async load(): Promise<void> {
    let raw: string;

    try {
      raw = fs.readFileSync(this.configPath, 'utf-8');
    } catch (err) {
      throw new BotError(ErrorCode.CONFIG_INVALID, `Cannot read config file: ${this.configPath}`, {
        path: this.configPath,
        error: String(err),
      });
    }

    let parsed: unknown;

    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new BotError(ErrorCode.CONFIG_INVALID, 'Invalid YAML in config file', {
        path: this.configPath,
        error: String(err),
      });
    }

    const result = configSchema.safeParse(parsed);

    if (!result.success) {
      throw new BotError(ErrorCode.CONFIG_INVALID, `Config validation failed: ${result.error.message}`, {
        path: this.configPath,
        errors: result.error.issues,
      });
    }

    this.config = result.data;
    logger.info('Config loaded successfully', { servers: result.data.servers.length });

    for (const callback of this.callbacks) {
      callback(result.data);
    }
  }

  /**
   * Get the current validated config.
   * @returns The validated bot config
   * @throws BotError with CONFIG_INVALID if config has not been loaded yet
   */
  public getConfig(): ValidatedConfig {
    if (!this.config) {
      throw new BotError(ErrorCode.CONFIG_INVALID, 'Config not loaded yet');
    }

    return this.config;
  }

  /**
   * Look up a channel config by guild and channel ID.
   * @param guildId - Discord guild/server ID
   * @param channelId - Discord channel ID
   * @returns Matching channel config, or undefined if not found
   */
  public getChannelConfig(guildId: string, channelId: string): ChannelConfig | undefined {
    if (!this.config) {
      return undefined;
    }

    const server = this.config.servers.find((item) => item.serverId === guildId);

    return server?.channels.find((channel) => channel.channelId === channelId);
  }

  /**
   * Register a callback for subsequent config reloads.
   * @param callback - Function called with the validated config after each load
   * @returns Nothing
   */
  public onChange(callback: ChangeCallback): void {
    this.callbacks.push(callback);
  }
}
