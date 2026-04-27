import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

/** Structural OpenCode SDK client methods used by CacheManager. */
export interface OpencodeCacheClient {
  app: {
    agents(): Promise<unknown[]>;
  };
  config: {
    providers(): Promise<unknown>;
  };
  session: {
    list(): Promise<unknown[]>;
  };
  mcp: {
    status(): Promise<Record<string, unknown>>;
  };
}

/** Cached OpenCode metadata for a project. */
export interface ProjectCache {
  agents: unknown[];
  models: unknown[];
  sessions: unknown[];
  mcpStatus: Record<string, unknown>;
  updatedAt: number;
}

/** Options for CacheManager construction. */
export interface CacheManagerOptions {
  cacheDir?: string;
  logger?: Pick<Logger, 'warn'>;
}

const defaultCache: ProjectCache = {
  agents: [],
  models: [],
  sessions: [],
  mcpStatus: {},
  updatedAt: 0,
};

function cacheFilePath(cacheDir: string, projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  return join(cacheDir, `${hash}.json`);
}

function normalizeModels(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (response !== null && typeof response === 'object' && 'providers' in response) {
    const providers = (response as { providers?: unknown }).providers;
    if (Array.isArray(providers)) {
      return providers;
    }
  }

  return response === undefined || response === null ? [] : [response];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProjectCache(value: unknown): ProjectCache | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    agents: Array.isArray(value.agents) ? value.agents : [],
    models: Array.isArray(value.models) ? value.models : [],
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    mcpStatus: isRecord(value.mcpStatus) ? value.mcpStatus : {},
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

/** Maintains in-memory and disk-backed OpenCode autocomplete metadata. */
export class CacheManager {
  private readonly cacheDir: string;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly cache = new Map<string, ProjectCache>();

  /**
   * Create an OpenCode cache manager.
   * @param options - Optional cache directory and logger
   */
  public constructor(options: CacheManagerOptions = {}) {
    this.cacheDir = options.cacheDir ?? join(process.cwd(), '.cache');
    this.logger = options.logger ?? createLogger('CacheManager');
  }

  /**
   * Refresh cached metadata for a project from the OpenCode SDK client.
   * @param projectPath - Project path used as the cache key
   * @param client - OpenCode SDK client with cacheable metadata methods
   * @returns Nothing
   */
  public async refresh(projectPath: string, client: OpencodeCacheClient): Promise<void> {
    const previous = this.getOrLoad(projectPath);
    const next: ProjectCache = {
      agents: await this.fetchOrDefault('agents', projectPath, () => client.app.agents(), previous.agents),
      models: await this.fetchOrDefault(
        'models',
        projectPath,
        async () => normalizeModels(await client.config.providers()),
        previous.models,
      ),
      sessions: await this.fetchOrDefault('sessions', projectPath, () => client.session.list(), previous.sessions),
      mcpStatus: await this.fetchOrDefault('mcpStatus', projectPath, () => client.mcp.status(), previous.mcpStatus),
      updatedAt: Date.now(),
    };

    this.cache.set(projectPath, next);
    this.write(projectPath, next);
  }

  /**
   * Get cached agents for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached agents or an empty array on cache miss
   */
  public getAgents(projectPath: string): unknown[] {
    return this.getOrLoad(projectPath).agents;
  }

  /**
   * Get cached models/providers for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached models or an empty array on cache miss
   */
  public getModels(projectPath: string): unknown[] {
    return this.getOrLoad(projectPath).models;
  }

  /**
   * Get cached sessions for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached sessions or an empty array on cache miss
   */
  public getSessions(projectPath: string): unknown[] {
    return this.getOrLoad(projectPath).sessions;
  }

  /**
   * Get cached MCP status for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached MCP status or an empty object on cache miss
   */
  public getMcpStatus(projectPath: string): Record<string, unknown> {
    return this.getOrLoad(projectPath).mcpStatus;
  }

  private async fetchOrDefault<T>(
    field: string,
    projectPath: string,
    fetchValue: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await fetchValue();
    } catch (error) {
      this.logger.warn('OpenCode cache refresh field failed', { field, projectPath, error });
      return fallback;
    }
  }

  private getOrLoad(projectPath: string): ProjectCache {
    const cached = this.cache.get(projectPath);
    if (cached !== undefined) {
      return cached;
    }

    const loaded = this.load(projectPath) ?? { ...defaultCache };
    this.cache.set(projectPath, loaded);
    return loaded;
  }

  private load(projectPath: string): ProjectCache | undefined {
    const filePath = cacheFilePath(this.cacheDir, projectPath);
    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      return parseProjectCache(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
      this.logger.warn('OpenCode cache read failed', { projectPath, error });
      return undefined;
    }
  }

  private write(projectPath: string, projectCache: ProjectCache): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const filePath = cacheFilePath(this.cacheDir, projectPath);
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(projectCache), 'utf8');
      renameSync(temporaryPath, filePath);
    } catch (error) {
      this.logger.warn('OpenCode cache write failed', { projectPath, error });
    }
  }
}
