# opencode-discord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task follows RED-GREEN-REFACTOR TDD methodology.

**Goal:** Discord bot (single token, multi-server) that maps Discord channels to OpenCode agents on local projects with thread-based passthrough.

**Architecture:** One `opencode serve` per unique project path, Discord threads map 1:1 to OpenCode sessions, SSE streaming with smart message splitting, per-thread message queue for ordering.

**Tech Stack:** Node.js + TypeScript (strict, ES2022), discord.js v14, @opencode-ai/sdk/v2, pnpm, vitest, tsup, Zod, chokidar, satori + @resvg/resvg-js

---

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `discord.js` | Discord bot framework (v14) |
| `@opencode-ai/sdk` | OpenCode server spawning and API client (use `/v2` import) |
| `cross-spawn` | Spawn `opencode serve` with custom `cwd` per project |
| `yaml` | YAML config parsing |
| `chokidar` | File watching for config hot-reload |
| `zod` | Config schema validation |
| `satori` | Render HTML/CSS to SVG (for table images) |
| `@resvg/resvg-js` | Convert SVG to PNG (for table images) |

### Development

| Package | Purpose |
|---------|---------|
| `typescript` | Type checking (strict mode, ES2022 target) |
| `tsup` | Build/bundle (ESM output) |
| `vitest` | Testing framework |
| `@types/node` | Node.js type definitions |

---

## File Structure

```
src/
├── index.ts                           # Entry point
├── config/
│   ├── loader.ts                      # YAML loading, validation, hot-reload
│   ├── schema.ts                      # Zod schema
│   └── types.ts                       # Config TypeScript types
├── state/
│   ├── manager.ts                     # StateManager: load, save (atomic), accessors
│   └── types.ts                       # BotState, ServerState, SessionState types
├── discord/
│   ├── client.ts                      # Discord.js client setup
│   ├── deploy.ts                      # Slash command registration
│   ├── commands/
│   │   ├── index.ts                   # Command registry
│   │   ├── new.ts, connect.ts, agent.ts, model.ts, interrupt.ts,
│   │   │   queue.ts, info.ts, end.ts, status.ts, help.ts, git.ts,
│   │   │   ls.ts, cat.ts, download.ts, restart.ts, mcp.ts, diff.ts,
│   │   │   revert.ts, summary.ts, fork.ts, todo.ts, retry.ts, context.ts
│   │   └── ...
│   └── handlers/
│       ├── interactionHandler.ts      # Route commands + autocomplete
│       └── messageHandler.ts          # Thread passthrough
├── opencode/
│   ├── serverManager.ts               # Spawn/track opencode serve per project
│   ├── sessionBridge.ts               # Session lifecycle, prompt sending
│   ├── streamHandler.ts               # SSE -> Discord message edits
│   ├── questionHandler.ts             # Handle question.asked events
│   ├── permissionHandler.ts           # Handle permission.asked events
│   ├── attachments.ts                 # Discord attachment handling
│   └── cache.ts                       # Agent/model/session/MCP cache
├── queue/
│   └── messageQueue.ts               # Per-thread message queue
└── utils/
    ├── errors.ts                      # BotError, error codes
    ├── formatter.ts                   # Markdown conversion, splitting, table detection
    ├── tableRenderer.ts               # satori + resvg PNG rendering
    ├── filesystem.ts                  # Path security, autocomplete, listing
    ├── permissions.ts                 # User/agent permission checks
    └── logger.ts                      # Structured logging with correlation IDs
```

---

## Execution Strategy

### Rounds (Parallel Execution Model)

Tasks within a round are **independent** and can be dispatched to sub-agents in parallel. Rounds must execute sequentially (each depends on prior round exports).

| Round | Tasks | Sub-agents |
|-------|-------|------------|
| 1 | Scaffolding + Config + State + Utilities | 2 parallel |
| 2 | Discord Core + OpenCode Integration + Stream Handler | 3 parallel |
| 3 | Commands (3 batches) + Attachments | 4 parallel |
| 4 | Integration Wiring + E2E Testing | 1 sequential |

### Review Gates

After EACH task within a round:
1. **Spec Compliance Review** — Does implementation match PLAN.md exactly? Nothing missing, nothing extra?
2. **Code Quality Review** — Named exports, BotError, JSDoc, module boundaries, TDD compliance?

After EACH round completes:
3. **Integration Check** — `pnpm tsc --noEmit && pnpm test`
4. **Commit** — `git add . && git commit -m "feat: round N - description"`

---

## Round 1: Foundation

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Initialize project and install dependencies**

```bash
pnpm init
pnpm add discord.js @opencode-ai/sdk cross-spawn yaml chokidar zod satori @resvg/resvg-js
pnpm add -D typescript tsup vitest @types/node
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export const config = defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
});
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export const config = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
```

- [ ] **Step 5: Create minimal src/index.ts entry point**

```typescript
export { ConfigLoader } from './config/loader.js';
export { StateManager } from './state/manager.js';
```

- [ ] **Step 6: Add scripts to package.json**

Add `"type": "module"` and scripts:
```json
{
  "type": "module",
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 7: Verify scaffolding compiles**

```bash
pnpm tsc --noEmit
```

Expected: Passes (or errors only about missing source files which will be created next).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: project scaffolding with TypeScript, vitest, tsup"
```

---

### Task 2: Error Types & BotError Class

**Files:**
- Create: `src/utils/errors.ts`
- Create: `src/utils/errors.test.ts`

- [ ] **Step 1: Write failing test for BotError**

```typescript
// src/utils/errors.test.ts
import { describe, it, expect } from 'vitest';
import { BotError, ErrorCode } from './errors.js';

describe('BotError', () => {
  it('creates error with code and message', () => {
    const err = new BotError(ErrorCode.CONFIG_INVALID, 'bad config');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BotError);
    expect(err.code).toBe(ErrorCode.CONFIG_INVALID);
    expect(err.message).toBe('bad config');
    expect(err.name).toBe('BotError');
  });

  it('accepts optional context record', () => {
    const err = new BotError(ErrorCode.PERMISSION_DENIED, 'no access', {
      userId: '123',
      channelId: '456',
    });
    expect(err.context).toEqual({ userId: '123', channelId: '456' });
  });

  it('has empty context by default', () => {
    const err = new BotError(ErrorCode.SERVER_START_FAILED, 'failed');
    expect(err.context).toEqual({});
  });

  it('is throwable and catchable', () => {
    expect(() => {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'missing');
    }).toThrow(BotError);
  });
});

describe('ErrorCode', () => {
  it('has all required error codes', () => {
    const requiredCodes = [
      'CONFIG_INVALID', 'CONFIG_CHANNEL_NOT_FOUND',
      'PERMISSION_DENIED',
      'AGENT_NOT_FOUND', 'AGENT_SWITCH_DISABLED', 'AGENT_NOT_ALLOWED',
      'MODEL_NOT_FOUND',
      'SERVER_START_FAILED', 'SERVER_UNHEALTHY',
      'SESSION_NOT_FOUND', 'SESSION_ALREADY_ATTACHED',
      'PATH_ESCAPE', 'FILE_NOT_FOUND',
      'GIT_DIRTY', 'GIT_CONFLICT',
      'DISCORD_API_ERROR',
      'MCP_NOT_FOUND', 'MCP_CONNECT_FAILED',
      'CONTEXT_BUFFER_FULL',
      'NO_MESSAGE_TO_RETRY', 'NO_MESSAGE_TO_REVERT',
      'FORK_FAILED',
      'QUESTION_INVALID_ANSWER', 'QUESTION_TIMEOUT',
      'PERMISSION_TIMEOUT',
    ];
    for (const code of requiredCodes) {
      expect(ErrorCode[code as keyof typeof ErrorCode]).toBe(code);
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/utils/errors.test.ts
```

Expected: FAIL — module `./errors.js` not found.

- [ ] **Step 3: Implement BotError and ErrorCode**

```typescript
// src/utils/errors.ts

/** All structured error codes used by the bot */
export const ErrorCode = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_CHANNEL_NOT_FOUND: 'CONFIG_CHANNEL_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_SWITCH_DISABLED: 'AGENT_SWITCH_DISABLED',
  AGENT_NOT_ALLOWED: 'AGENT_NOT_ALLOWED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  SERVER_START_FAILED: 'SERVER_START_FAILED',
  SERVER_UNHEALTHY: 'SERVER_UNHEALTHY',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ALREADY_ATTACHED: 'SESSION_ALREADY_ATTACHED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  GIT_DIRTY: 'GIT_DIRTY',
  GIT_CONFLICT: 'GIT_CONFLICT',
  DISCORD_API_ERROR: 'DISCORD_API_ERROR',
  MCP_NOT_FOUND: 'MCP_NOT_FOUND',
  MCP_CONNECT_FAILED: 'MCP_CONNECT_FAILED',
  CONTEXT_BUFFER_FULL: 'CONTEXT_BUFFER_FULL',
  NO_MESSAGE_TO_RETRY: 'NO_MESSAGE_TO_RETRY',
  NO_MESSAGE_TO_REVERT: 'NO_MESSAGE_TO_REVERT',
  FORK_FAILED: 'FORK_FAILED',
  QUESTION_INVALID_ANSWER: 'QUESTION_INVALID_ANSWER',
  QUESTION_TIMEOUT: 'QUESTION_TIMEOUT',
  PERMISSION_TIMEOUT: 'PERMISSION_TIMEOUT',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Structured error class for all bot-thrown errors.
 * @param code - Error code from ErrorCode enum
 * @param message - Human-readable error description
 * @param context - Optional key-value metadata for logging/debugging
 */
export class BotError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BotError';
    this.code = code;
    this.context = context;
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/utils/errors.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: BotError class with structured error codes"
```

---

### Task 3: Logger Utility

**Files:**
- Create: `src/utils/logger.ts`
- Create: `src/utils/logger.test.ts`

- [ ] **Step 1: Write failing test for Logger**

```typescript
// src/utils/logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger, generateCorrelationId } from './logger.js';

describe('generateCorrelationId', () => {
  it('generates ID in format threadId-timestamp', () => {
    const id = generateCorrelationId('1234567890123456');
    expect(id).toMatch(/^1234567890123456-\d+$/);
  });
});

describe('createLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('logs debug messages with structured metadata', () => {
    const logger = createLogger('TestModule');
    logger.debug('test message', { key: 'value' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"debug"')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"module":"TestModule"')
    );
  });

  it('logs info messages', () => {
    const logger = createLogger('TestModule');
    logger.info('info message', { correlationId: 'abc-123' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"info"')
    );
  });

  it('logs warn messages', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const logger = createLogger('TestModule');
    logger.warn('warning', { reason: 'test' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"warn"')
    );
  });

  it('logs error messages', () => {
    const errorSpy = vi.spyOn(console, 'error');
    const logger = createLogger('TestModule');
    logger.error('error occurred', { error: 'boom' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"error"')
    );
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/utils/logger.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement Logger**

```typescript
// src/utils/logger.ts

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Generate a correlation ID for request tracing.
 * @param threadId - Discord thread ID
 * @returns Correlation ID in format `threadId-timestamp`
 */
export function generateCorrelationId(threadId: string): string {
  return `${threadId}-${Date.now()}`;
}

/**
 * Create a structured JSON logger for a module.
 * @param module - Module name for log context
 * @returns Logger instance with debug/info/warn/error methods
 */
export function createLogger(module: string): Logger {
  const log = (level: string, msg: string, meta: Record<string, unknown> = {}) => {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      module,
      msg,
      ...meta,
    });

    switch (level) {
      case 'warn':
        console.warn(entry);
        break;
      case 'error':
        console.error(entry);
        break;
      default:
        console.log(entry);
    }
  };

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/utils/logger.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: structured JSON logger with correlation IDs"
```

---

### Task 4: Config Types

**Files:**
- Create: `src/config/types.ts`

- [ ] **Step 1: Create config types (no test needed — pure type definitions)**

```typescript
// src/config/types.ts

/** Configuration for a single Discord channel mapping */
export interface ChannelConfig {
  channelId: string;
  projectPath: string;
  defaultAgent?: string;
  allowAgentSwitch?: boolean;
  allowedAgents?: string[];
  allowedUsers?: string[];
  permissions?: 'auto' | 'interactive';
  questionTimeout?: number;
  connectHistoryLimit?: number;
  autoConnect?: boolean;
}

/** Configuration for a Discord server (guild) */
export interface ServerConfig {
  serverId: string;
  channels: ChannelConfig[];
}

/** Root bot configuration */
export interface BotConfig {
  discordToken: string;
  servers: ServerConfig[];
}
```

- [ ] **Step 2: Verify types compile**

```bash
pnpm tsc --noEmit
```

Expected: No errors (or only errors from missing imports in index.ts, which is acceptable at this stage).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: config TypeScript types (BotConfig, ServerConfig, ChannelConfig)"
```

---

### Task 5: Config Zod Schema

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/schema.test.ts`

- [ ] **Step 1: Write failing tests for schema validation**

```typescript
// src/config/schema.test.ts
import { describe, it, expect } from 'vitest';
import { configSchema } from './schema.js';

const validConfig = {
  discordToken: 'test-token-123',
  servers: [
    {
      serverId: '111111111111111111',
      channels: [
        {
          channelId: '222222222222222222',
          projectPath: '/Users/test/project',
        },
      ],
    },
  ],
};

describe('configSchema', () => {
  it('validates a minimal valid config', () => {
    const result = configSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('applies defaults for optional channel fields', () => {
    const result = configSchema.parse(validConfig);
    const channel = result.servers[0]!.channels[0]!;
    expect(channel.allowAgentSwitch).toBe(true);
    expect(channel.allowedAgents).toEqual([]);
    expect(channel.allowedUsers).toEqual([]);
    expect(channel.permissions).toBe('auto');
    expect(channel.questionTimeout).toBe(300);
    expect(channel.connectHistoryLimit).toBe(10);
    expect(channel.autoConnect).toBe(false);
  });

  it('rejects config without discordToken', () => {
    const result = configSchema.safeParse({ servers: [] });
    expect(result.success).toBe(false);
  });

  it('rejects config without servers', () => {
    const result = configSchema.safeParse({ discordToken: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects empty serverId', () => {
    const result = configSchema.safeParse({
      discordToken: 'x',
      servers: [{ serverId: '', channels: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative connectHistoryLimit', () => {
    const config = structuredClone(validConfig);
    config.servers[0]!.channels[0] = {
      ...config.servers[0]!.channels[0]!,
      connectHistoryLimit: -1,
    } as any;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid permissions value', () => {
    const config = structuredClone(validConfig);
    config.servers[0]!.channels[0] = {
      ...config.servers[0]!.channels[0]!,
      permissions: 'invalid',
    } as any;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts full config with all optional fields', () => {
    const fullConfig = {
      discordToken: 'token',
      servers: [{
        serverId: '111',
        channels: [{
          channelId: '222',
          projectPath: '/path',
          defaultAgent: 'code',
          allowAgentSwitch: false,
          allowedAgents: ['code', 'build'],
          allowedUsers: ['user1'],
          permissions: 'interactive',
          questionTimeout: 60,
          connectHistoryLimit: 5,
          autoConnect: true,
        }],
      }],
    };
    const result = configSchema.safeParse(fullConfig);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/config/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement Zod schema**

```typescript
// src/config/schema.ts
import { z } from 'zod';

/** Zod schema for a single channel configuration */
export const channelSchema = z.object({
  channelId: z.string().min(1),
  projectPath: z.string().min(1),
  defaultAgent: z.string().optional(),
  allowAgentSwitch: z.boolean().default(true),
  allowedAgents: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  permissions: z.enum(['auto', 'interactive']).default('auto'),
  questionTimeout: z.number().int().positive().default(300),
  connectHistoryLimit: z.number().int().nonnegative().default(10),
  autoConnect: z.boolean().default(false),
});

/** Zod schema for a Discord server (guild) */
export const serverSchema = z.object({
  serverId: z.string().min(1),
  channels: z.array(channelSchema),
});

/** Root config schema */
export const configSchema = z.object({
  discordToken: z.string().min(1),
  servers: z.array(serverSchema),
});

export type ValidatedConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/config/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Zod config schema with defaults and validation"
```

---

### Task 6: Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Create: `src/config/loader.test.ts`

- [ ] **Step 1: Write failing tests for config loader**

```typescript
// src/config/loader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from './loader.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ConfigLoader', () => {
  let tmpDir: string;
  let configPath: string;

  const validYaml = `
discordToken: test-token
servers:
  - serverId: "111"
    channels:
      - channelId: "222"
        projectPath: "/tmp/project"
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and validates a config file', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const config = loader.getConfig();
    expect(config.discordToken).toBe('test-token');
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]!.channels[0]!.channelId).toBe('222');
  });

  it('throws BotError on invalid YAML', async () => {
    fs.writeFileSync(configPath, 'invalid: [unclosed');
    const loader = new ConfigLoader(configPath);
    await expect(loader.load()).rejects.toThrow();
  });

  it('throws BotError on schema validation failure', async () => {
    fs.writeFileSync(configPath, 'servers: []');
    const loader = new ConfigLoader(configPath);
    await expect(loader.load()).rejects.toThrow();
  });

  it('getChannelConfig returns config for known channel', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const channel = loader.getChannelConfig('111', '222');
    expect(channel).toBeDefined();
    expect(channel!.projectPath).toBe('/tmp/project');
  });

  it('getChannelConfig returns undefined for unknown channel', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const channel = loader.getChannelConfig('111', '999');
    expect(channel).toBeUndefined();
  });

  it('emits onChange callback when config reloaded', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const callback = vi.fn();
    loader.onChange(callback);
    // Simulate reload
    await loader.load();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/config/loader.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ConfigLoader**

```typescript
// src/config/loader.ts
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, type ValidatedConfig } from './schema.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type { ChannelConfig } from './types.js';

const logger = createLogger('ConfigLoader');

type ChangeCallback = (config: ValidatedConfig) => void;

/**
 * Loads, validates, and manages the bot configuration from a YAML file.
 * Supports hot-reload via onChange callbacks.
 */
export class ConfigLoader {
  private config: ValidatedConfig | null = null;
  private readonly configPath: string;
  private readonly callbacks: ChangeCallback[] = [];

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  /**
   * Load and validate the config file.
   * @throws BotError with CONFIG_INVALID if file is missing, unparseable, or fails schema
   */
  async load(): Promise<void> {
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
      throw new BotError(ErrorCode.CONFIG_INVALID, `Invalid YAML in config file`, {
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

    // Notify listeners
    for (const cb of this.callbacks) {
      cb(result.data);
    }
  }

  /**
   * Get the current validated config.
   * @returns The validated bot config
   * @throws BotError if config hasn't been loaded yet
   */
  getConfig(): ValidatedConfig {
    if (!this.config) {
      throw new BotError(ErrorCode.CONFIG_INVALID, 'Config not loaded yet');
    }
    return this.config;
  }

  /**
   * Look up a channel's config by guild and channel ID.
   * @param guildId - Discord guild (server) ID
   * @param channelId - Discord channel ID
   * @returns ChannelConfig if found, undefined otherwise
   */
  getChannelConfig(guildId: string, channelId: string): ChannelConfig | undefined {
    if (!this.config) return undefined;
    const server = this.config.servers.find((s) => s.serverId === guildId);
    if (!server) return undefined;
    return server.channels.find((c) => c.channelId === channelId) as ChannelConfig | undefined;
  }

  /**
   * Register a callback for config changes (hot-reload).
   * @param callback - Function called with new config on reload
   */
  onChange(callback: ChangeCallback): void {
    this.callbacks.push(callback);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/config/loader.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ConfigLoader with YAML parsing, Zod validation, and hot-reload callbacks"
```

---

### Task 7: State Types

**Files:**
- Create: `src/state/types.ts`

- [ ] **Step 1: Create state types (pure type definitions)**

```typescript
// src/state/types.ts

/** Status of a managed opencode serve process */
export type ServerStatus = 'running' | 'stopped' | 'starting';

/** Persisted information about an opencode serve process */
export interface ServerState {
  port: number;
  pid: number;
  url: string;
  startedAt: number;
  status: ServerStatus;
}

/** Session status in the bot's lifecycle */
export type SessionStatus = 'active' | 'inactive' | 'ended';

/** Persisted information about a session mapping */
export interface SessionState {
  sessionId: string;
  guildId: string;
  channelId: string;
  projectPath: string;
  agent: string;
  model: string | null;
  createdBy: string;
  createdAt: number;
  lastActivityAt: number;
  status: SessionStatus;
}

/** A queued message waiting to be sent to the agent */
export interface QueueEntry {
  userId: string;
  content: string;
  attachments: string[];
  queuedAt: number;
}

/** Root state schema persisted to state.json */
export interface BotState {
  version: number;
  servers: Record<string, ServerState>;
  sessions: Record<string, SessionState>;
  queues: Record<string, QueueEntry[]>;
}

/** Empty initial state */
export const EMPTY_STATE: BotState = {
  version: 1,
  servers: {},
  sessions: {},
  queues: {},
};
```

- [ ] **Step 2: Verify types compile**

```bash
pnpm tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: state types (BotState, ServerState, SessionState, QueueEntry)"
```

---

### Task 8: State Manager

**Files:**
- Create: `src/state/manager.ts`
- Create: `src/state/manager.test.ts`

- [ ] **Step 1: Write failing tests for StateManager**

```typescript
// src/state/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from './manager.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SessionState, ServerState, QueueEntry } from './types.js';

describe('StateManager', () => {
  let tmpDir: string;
  let statePath: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    statePath = path.join(tmpDir, 'state.json');
    manager = new StateManager(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('creates empty state when file does not exist', () => {
      manager.load();
      expect(manager.getState().version).toBe(1);
      expect(manager.getState().servers).toEqual({});
      expect(manager.getState().sessions).toEqual({});
      expect(manager.getState().queues).toEqual({});
    });

    it('loads existing state from disk', () => {
      const existing = {
        version: 1,
        servers: {},
        sessions: { 'thread1': { sessionId: 'sess_1', status: 'active' } },
        queues: {},
      };
      fs.writeFileSync(statePath, JSON.stringify(existing));
      manager.load();
      expect(manager.getSession('thread1')?.sessionId).toBe('sess_1');
    });
  });

  describe('save', () => {
    it('writes state to disk atomically', () => {
      manager.load();
      manager.setSession('thread1', {
        sessionId: 'sess_1',
        guildId: 'g1',
        channelId: 'c1',
        projectPath: '/tmp/p',
        agent: 'code',
        model: null,
        createdBy: 'u1',
        createdAt: 1000,
        lastActivityAt: 1000,
        status: 'active',
      });
      // Verify file written
      const raw = fs.readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessions.thread1.sessionId).toBe('sess_1');
    });

    it('temp file does not persist after save', () => {
      manager.load();
      manager.setSession('t1', {
        sessionId: 's1', guildId: 'g', channelId: 'c',
        projectPath: '/p', agent: 'a', model: null,
        createdBy: 'u', createdAt: 0, lastActivityAt: 0, status: 'active',
      });
      const tmpFile = statePath + '.tmp';
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe('session accessors', () => {
    it('setSession and getSession', () => {
      manager.load();
      const session: SessionState = {
        sessionId: 'sess_x', guildId: 'g1', channelId: 'c1',
        projectPath: '/p', agent: 'build', model: 'anthropic/claude-sonnet-4-20250514',
        createdBy: 'u1', createdAt: 100, lastActivityAt: 100, status: 'active',
      };
      manager.setSession('thread_x', session);
      expect(manager.getSession('thread_x')).toEqual(session);
    });

    it('removeSession', () => {
      manager.load();
      manager.setSession('t1', {
        sessionId: 's1', guildId: 'g', channelId: 'c',
        projectPath: '/p', agent: 'a', model: null,
        createdBy: 'u', createdAt: 0, lastActivityAt: 0, status: 'active',
      });
      manager.removeSession('t1');
      expect(manager.getSession('t1')).toBeUndefined();
    });
  });

  describe('server accessors', () => {
    it('setServer and getServer', () => {
      manager.load();
      const server: ServerState = {
        port: 3000, pid: 123, url: 'http://127.0.0.1:3000',
        startedAt: 100, status: 'running',
      };
      manager.setServer('/path/project', server);
      expect(manager.getServer('/path/project')).toEqual(server);
    });
  });

  describe('queue accessors', () => {
    it('enqueue and getQueue', () => {
      manager.load();
      const entry: QueueEntry = {
        userId: 'u1', content: 'hello', attachments: [], queuedAt: 100,
      };
      manager.enqueue('thread1', entry);
      expect(manager.getQueue('thread1')).toEqual([entry]);
    });

    it('dequeue returns first entry', () => {
      manager.load();
      manager.enqueue('t1', { userId: 'u', content: 'first', attachments: [], queuedAt: 1 });
      manager.enqueue('t1', { userId: 'u', content: 'second', attachments: [], queuedAt: 2 });
      const entry = manager.dequeue('t1');
      expect(entry?.content).toBe('first');
      expect(manager.getQueue('t1')).toHaveLength(1);
    });

    it('clearQueue empties thread queue', () => {
      manager.load();
      manager.enqueue('t1', { userId: 'u', content: 'msg', attachments: [], queuedAt: 1 });
      manager.clearQueue('t1');
      expect(manager.getQueue('t1')).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/state/manager.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement StateManager**

```typescript
// src/state/manager.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotState, ServerState, SessionState, QueueEntry } from './types.js';
import { EMPTY_STATE } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StateManager');

/**
 * Manages bot runtime state with atomic persistence to disk.
 * All reads from in-memory object, writes trigger atomic save.
 */
export class StateManager {
  private state: BotState = { ...EMPTY_STATE };
  private readonly statePath: string;

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  /** Load state from disk, or create empty state if file doesn't exist */
  load(): void {
    if (fs.existsSync(this.statePath)) {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      this.state = JSON.parse(raw) as BotState;
      logger.info('State loaded from disk', { sessions: Object.keys(this.state.sessions).length });
    } else {
      this.state = { ...EMPTY_STATE, servers: {}, sessions: {}, queues: {} };
      logger.info('No state file found, starting fresh');
    }
  }

  /** Get the full state object (read-only reference) */
  getState(): BotState {
    return this.state;
  }

  // --- Session accessors ---

  /** @returns Session state for a thread, or undefined */
  getSession(threadId: string): SessionState | undefined {
    return this.state.sessions[threadId];
  }

  /** Set session for a thread and persist */
  setSession(threadId: string, session: SessionState): void {
    this.state.sessions[threadId] = session;
    this.save();
  }

  /** Remove a session mapping and persist */
  removeSession(threadId: string): void {
    delete this.state.sessions[threadId];
    this.save();
  }

  // --- Server accessors ---

  /** @returns Server state for a project path, or undefined */
  getServer(projectPath: string): ServerState | undefined {
    return this.state.servers[projectPath];
  }

  /** Set server state for a project and persist */
  setServer(projectPath: string, server: ServerState): void {
    this.state.servers[projectPath] = server;
    this.save();
  }

  /** Remove server state and persist */
  removeServer(projectPath: string): void {
    delete this.state.servers[projectPath];
    this.save();
  }

  // --- Queue accessors ---

  /** @returns Queue entries for a thread (empty array if none) */
  getQueue(threadId: string): QueueEntry[] {
    return this.state.queues[threadId] ?? [];
  }

  /** Add an entry to a thread's queue and persist */
  enqueue(threadId: string, entry: QueueEntry): void {
    if (!this.state.queues[threadId]) {
      this.state.queues[threadId] = [];
    }
    this.state.queues[threadId]!.push(entry);
    this.save();
  }

  /** Remove and return the first entry from a thread's queue, persist */
  dequeue(threadId: string): QueueEntry | undefined {
    const queue = this.state.queues[threadId];
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift()!;
    this.save();
    return entry;
  }

  /** Clear all entries in a thread's queue and persist */
  clearQueue(threadId: string): void {
    this.state.queues[threadId] = [];
    this.save();
  }

  // --- Persistence ---

  /** Atomic write: write to tmp file, then rename */
  private save(): void {
    const tmpPath = this.statePath + '.tmp';
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmpPath, this.statePath);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/state/manager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: StateManager with atomic writes and typed accessors"
```

---

### Task 9: Filesystem Utility (Path Security)

**Files:**
- Create: `src/utils/filesystem.ts`
- Create: `src/utils/filesystem.test.ts`

- [ ] **Step 1: Write failing tests for path security**

```typescript
// src/utils/filesystem.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSafePath, listDirectory, inferLanguage } from './filesystem.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('resolveSafePath', () => {
  it('resolves relative path within project root', () => {
    const result = resolveSafePath('/project', 'src/index.ts');
    expect(result).toBe('/project/src/index.ts');
  });

  it('throws on path traversal with ../', () => {
    expect(() => resolveSafePath('/project', '../etc/passwd')).toThrow();
  });

  it('throws on absolute path outside project', () => {
    expect(() => resolveSafePath('/project', '/etc/passwd')).toThrow();
  });

  it('handles empty relative path as project root', () => {
    const result = resolveSafePath('/project', '');
    expect(result).toBe('/project');
  });

  it('handles nested ../ that stays within project', () => {
    const result = resolveSafePath('/project', 'src/../lib/utils.ts');
    expect(result).toBe('/project/lib/utils.ts');
  });
});

describe('listDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
    fs.writeFileSync(path.join(tmpDir, '.hidden'), 'content');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists directory contents with trailing / for directories', async () => {
    const entries = await listDirectory(tmpDir);
    expect(entries).toContain('subdir/');
    expect(entries).toContain('file.ts');
    expect(entries).toContain('.hidden');
  });

  it('sorts directories first, then files', async () => {
    const entries = await listDirectory(tmpDir);
    const dirIdx = entries.indexOf('subdir/');
    const fileIdx = entries.indexOf('file.ts');
    expect(dirIdx).toBeLessThan(fileIdx);
  });
});

describe('inferLanguage', () => {
  it('infers typescript from .ts', () => {
    expect(inferLanguage('file.ts')).toBe('typescript');
  });

  it('infers javascript from .js', () => {
    expect(inferLanguage('file.js')).toBe('javascript');
  });

  it('infers json from .json', () => {
    expect(inferLanguage('file.json')).toBe('json');
  });

  it('returns empty string for unknown extension', () => {
    expect(inferLanguage('file.xyz')).toBe('');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/utils/filesystem.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement filesystem utilities**

```typescript
// src/utils/filesystem.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BotError, ErrorCode } from './errors.js';

/**
 * Resolve a relative path safely within a project root.
 * @param projectRoot - Absolute path to the project root
 * @param relativePath - User-provided relative path
 * @returns Resolved absolute path guaranteed to be within projectRoot
 * @throws BotError with PATH_ESCAPE if path escapes project root
 */
export function resolveSafePath(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath || '.');
  const normalizedRoot = path.resolve(projectRoot);

  if (!resolved.startsWith(normalizedRoot)) {
    throw new BotError(ErrorCode.PATH_ESCAPE, `Path escapes project root: ${relativePath}`, {
      projectRoot,
      relativePath,
      resolved,
    });
  }

  return resolved;
}

/**
 * List directory contents with trailing / for directories.
 * @param dirPath - Absolute path to directory
 * @returns Sorted array: directories first (with trailing /), then files
 */
export async function listDirectory(dirPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name + '/');
    } else {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  return [...dirs, ...files];
}

/** Language extension mapping for syntax highlighting */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.css': 'css',
  '.html': 'html',
  '.sql': 'sql',
  '.toml': 'toml',
  '.xml': 'xml',
  '.diff': 'diff',
};

/**
 * Infer syntax highlighting language from file extension.
 * @param filePath - File path or name
 * @returns Language identifier for fenced code blocks, or empty string
 */
export function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? '';
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/utils/filesystem.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: filesystem utilities with path security, directory listing, language inference"
```

---

### Task 10: Permissions Utility

**Files:**
- Create: `src/utils/permissions.ts`
- Create: `src/utils/permissions.test.ts`

- [ ] **Step 1: Write failing tests for permission checks**

```typescript
// src/utils/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { checkUserAllowed, checkAgentAllowed } from './permissions.js';
import type { ChannelConfig } from '../config/types.js';

const baseChannel: ChannelConfig = {
  channelId: '123',
  projectPath: '/tmp',
};

describe('checkUserAllowed', () => {
  it('allows any user when allowedUsers is empty', () => {
    expect(checkUserAllowed(baseChannel, 'anyone')).toBe(true);
  });

  it('allows user in allowedUsers list', () => {
    const channel = { ...baseChannel, allowedUsers: ['user1', 'user2'] };
    expect(checkUserAllowed(channel, 'user1')).toBe(true);
  });

  it('rejects user not in allowedUsers list', () => {
    const channel = { ...baseChannel, allowedUsers: ['user1'] };
    expect(checkUserAllowed(channel, 'user2')).toBe(false);
  });
});

describe('checkAgentAllowed', () => {
  it('allows any agent when allowAgentSwitch is undefined (default true)', () => {
    expect(checkAgentAllowed(baseChannel, 'any-agent')).toBe(true);
  });

  it('rejects agent switch when allowAgentSwitch is false', () => {
    const channel = { ...baseChannel, allowAgentSwitch: false };
    expect(checkAgentAllowed(channel, 'code')).toEqual({
      allowed: false,
      reason: 'AGENT_SWITCH_DISABLED',
    });
  });

  it('allows agent in allowedAgents list', () => {
    const channel = { ...baseChannel, allowedAgents: ['code', 'build'] };
    expect(checkAgentAllowed(channel, 'code')).toBe(true);
  });

  it('rejects agent not in allowedAgents list', () => {
    const channel = { ...baseChannel, allowedAgents: ['code'] };
    expect(checkAgentAllowed(channel, 'hack')).toEqual({
      allowed: false,
      reason: 'AGENT_NOT_ALLOWED',
    });
  });

  it('allows any agent when allowedAgents is empty', () => {
    const channel = { ...baseChannel, allowedAgents: [] };
    expect(checkAgentAllowed(channel, 'anything')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/utils/permissions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement permission checks**

```typescript
// src/utils/permissions.ts
import type { ChannelConfig } from '../config/types.js';

/**
 * Check if a user is allowed to interact in a channel.
 * @param channel - Channel configuration
 * @param userId - Discord user ID
 * @returns true if allowed (empty allowedUsers means everyone allowed)
 */
export function checkUserAllowed(channel: ChannelConfig, userId: string): boolean {
  if (!channel.allowedUsers || channel.allowedUsers.length === 0) {
    return true;
  }
  return channel.allowedUsers.includes(userId);
}

export type AgentCheckResult = true | { allowed: false; reason: 'AGENT_SWITCH_DISABLED' | 'AGENT_NOT_ALLOWED' };

/**
 * Check if an agent selection is allowed for a channel.
 * @param channel - Channel configuration
 * @param agentName - Agent name to validate
 * @returns true if allowed, or rejection reason object
 */
export function checkAgentAllowed(channel: ChannelConfig, agentName: string): AgentCheckResult {
  if (channel.allowAgentSwitch === false) {
    return { allowed: false, reason: 'AGENT_SWITCH_DISABLED' };
  }

  if (channel.allowedAgents && channel.allowedAgents.length > 0) {
    if (!channel.allowedAgents.includes(agentName)) {
      return { allowed: false, reason: 'AGENT_NOT_ALLOWED' };
    }
  }

  return true;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/utils/permissions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: permission utilities (user allowed, agent allowed checks)"
```

---

### Task 11: Message Formatter (Splitting & Code Block Continuity)

**Files:**
- Create: `src/utils/formatter.ts`
- Create: `src/utils/formatter.test.ts`

- [ ] **Step 1: Write failing tests for formatter**

```typescript
// src/utils/formatter.test.ts
import { describe, it, expect } from 'vitest';
import { splitMessage, detectTable, formatHistoryMessage } from './formatter.js';

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitMessage('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  it('splits at paragraph boundary near 1800 chars', () => {
    const para1 = 'A'.repeat(1700);
    const para2 = 'B'.repeat(200);
    const text = `${para1}\n\n${para2}`;
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it('maintains code block continuity across splits', () => {
    const code = '```typescript\n' + 'x\n'.repeat(300) + '```';
    const result = splitMessage(code);
    // Each chunk should be a valid code block
    for (const chunk of result) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0); // even number = all blocks closed
    }
  });

  it('re-opens code block with same language in next chunk', () => {
    const longCode = '```python\n' + 'print("hello")\n'.repeat(200) + '```';
    const result = splitMessage(longCode);
    if (result.length > 1) {
      expect(result[1]).toMatch(/^```python/);
    }
  });
});

describe('detectTable', () => {
  it('detects a markdown table', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(detectTable(table)).toBe(true);
  });

  it('rejects non-table pipe content', () => {
    expect(detectTable('this | is | not | a table')).toBe(false);
  });

  it('rejects text without separator row', () => {
    expect(detectTable('| A | B |\n| 1 | 2 |')).toBe(false);
  });
});

describe('formatHistoryMessage', () => {
  it('formats user messages with blockquote', () => {
    const result = formatHistoryMessage('user', 'hello');
    expect(result).toBe('**User:**\n> hello');
  });

  it('formats assistant messages without blockquote', () => {
    const result = formatHistoryMessage('assistant', 'response');
    expect(result).toBe('**Assistant:**\nresponse');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/utils/formatter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement formatter**

```typescript
// src/utils/formatter.ts

const MAX_CHUNK_SIZE = 1800;

/**
 * Split a message into Discord-safe chunks (~1800 chars max).
 * Splits at paragraph boundaries and maintains code block continuity.
 * @param text - Full message text
 * @returns Array of message chunks
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  let currentLang: string | null = null;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_SIZE) {
      chunks.push(currentLang ? `\`\`\`${currentLang}\n${remaining}` : remaining);
      break;
    }

    let splitAt = findSplitPoint(remaining, MAX_CHUNK_SIZE);
    let chunk = remaining.slice(0, splitAt);

    // Handle code block continuity
    const openBlocks = countUnclosedCodeBlocks(chunk);
    if (openBlocks.unclosed) {
      // Close the block in this chunk
      chunk += '\n```';
      currentLang = openBlocks.language;
    } else {
      currentLang = null;
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();

    // Re-open code block in next chunk
    if (currentLang && remaining.length > 0) {
      remaining = `\`\`\`${currentLang}\n${remaining}`;
      currentLang = null;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

function findSplitPoint(text: string, maxLen: number): number {
  // Try paragraph break
  const paraBreak = text.lastIndexOf('\n\n', maxLen);
  if (paraBreak > maxLen * 0.5) return paraBreak;

  // Try newline
  const newline = text.lastIndexOf('\n', maxLen);
  if (newline > maxLen * 0.5) return newline;

  // Try space
  const space = text.lastIndexOf(' ', maxLen);
  if (space > maxLen * 0.5) return space;

  // Hard cut
  return maxLen;
}

function countUnclosedCodeBlocks(text: string): { unclosed: boolean; language: string | null } {
  const matches = text.match(/```(\w*)/g) || [];
  const closes = (text.match(/```\s*$/gm) || []).length;
  // Simple heuristic: odd number of ``` markers means unclosed
  const allTicks = (text.match(/```/g) || []).length;
  if (allTicks % 2 !== 0) {
    // Find the last opening ```lang
    const lastOpen = text.lastIndexOf('```');
    const afterTicks = text.slice(lastOpen + 3);
    const langMatch = afterTicks.match(/^(\w+)/);
    return { unclosed: true, language: langMatch?.[1] ?? null };
  }
  return { unclosed: false, language: null };
}

/**
 * Detect if text contains a markdown table.
 * Requires a header row, separator row (|---|), and at least one data row.
 * @param text - Text to check
 * @returns true if a valid table structure is detected
 */
export function detectTable(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 3) return false;

  // Need at least: header | sep | data
  for (let i = 0; i < lines.length - 2; i++) {
    const header = lines[i]!;
    const sep = lines[i + 1]!;
    if (
      header.includes('|') &&
      header.trim().startsWith('|') &&
      sep.match(/^\|[\s\-:|]+\|/)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Format a history message for Discord replay.
 * @param role - 'user' or 'assistant'
 * @param content - Message text content
 * @returns Formatted Discord message string
 */
export function formatHistoryMessage(role: string, content: string): string {
  if (role === 'user') {
    const quoted = content.split('\n').map((l) => `> ${l}`).join('\n');
    return `**User:**\n${quoted}`;
  }
  return `**Assistant:**\n${content}`;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/utils/formatter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: message formatter with smart splitting and code block continuity"
```

---

### Task 12: Message Queue

**Files:**
- Create: `src/queue/messageQueue.ts`
- Create: `src/queue/messageQueue.test.ts`

- [ ] **Step 1: Write failing tests for MessageQueue**

```typescript
// src/queue/messageQueue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from './messageQueue.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  it('enqueues and dequeues in FIFO order', () => {
    queue.enqueue('thread1', { userId: 'u1', content: 'first', attachments: [], queuedAt: 1 });
    queue.enqueue('thread1', { userId: 'u1', content: 'second', attachments: [], queuedAt: 2 });
    expect(queue.dequeue('thread1')?.content).toBe('first');
    expect(queue.dequeue('thread1')?.content).toBe('second');
  });

  it('returns undefined when dequeuing empty queue', () => {
    expect(queue.dequeue('nonexistent')).toBeUndefined();
  });

  it('lists queue contents', () => {
    queue.enqueue('t1', { userId: 'u', content: 'a', attachments: [], queuedAt: 1 });
    queue.enqueue('t1', { userId: 'u', content: 'b', attachments: [], queuedAt: 2 });
    expect(queue.list('t1')).toHaveLength(2);
  });

  it('clears a thread queue', () => {
    queue.enqueue('t1', { userId: 'u', content: 'msg', attachments: [], queuedAt: 1 });
    queue.clear('t1');
    expect(queue.list('t1')).toHaveLength(0);
  });

  it('tracks queue size per thread', () => {
    queue.enqueue('t1', { userId: 'u', content: 'a', attachments: [], queuedAt: 1 });
    queue.enqueue('t1', { userId: 'u', content: 'b', attachments: [], queuedAt: 2 });
    expect(queue.size('t1')).toBe(2);
    expect(queue.size('t2')).toBe(0);
  });

  it('deduplicates by message content within same thread', () => {
    queue.enqueue('t1', { userId: 'u', content: 'same', attachments: [], queuedAt: 1 });
    queue.enqueue('t1', { userId: 'u', content: 'same', attachments: [], queuedAt: 2 });
    expect(queue.size('t1')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm test src/queue/messageQueue.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement MessageQueue**

```typescript
// src/queue/messageQueue.ts
import type { QueueEntry } from '../state/types.js';

/**
 * Per-thread in-memory message queue with FIFO ordering and deduplication.
 */
export class MessageQueue {
  private queues: Map<string, QueueEntry[]> = new Map();
  private recentContent: Map<string, Set<string>> = new Map();

  /**
   * Add a message to a thread's queue. Deduplicates by content.
   * @param threadId - Discord thread ID
   * @param entry - Queue entry to add
   */
  enqueue(threadId: string, entry: QueueEntry): void {
    if (!this.queues.has(threadId)) {
      this.queues.set(threadId, []);
      this.recentContent.set(threadId, new Set());
    }

    const contentKey = entry.content;
    const recent = this.recentContent.get(threadId)!;
    if (recent.has(contentKey)) {
      return; // deduplicate
    }

    recent.add(contentKey);
    this.queues.get(threadId)!.push(entry);
  }

  /**
   * Remove and return the first entry from a thread's queue.
   * @param threadId - Discord thread ID
   * @returns First queue entry, or undefined if empty
   */
  dequeue(threadId: string): QueueEntry | undefined {
    const queue = this.queues.get(threadId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift()!;
    this.recentContent.get(threadId)?.delete(entry.content);
    return entry;
  }

  /**
   * List all entries in a thread's queue without removing them.
   * @param threadId - Discord thread ID
   * @returns Array of queue entries
   */
  list(threadId: string): QueueEntry[] {
    return this.queues.get(threadId) ?? [];
  }

  /**
   * Clear all entries in a thread's queue.
   * @param threadId - Discord thread ID
   */
  clear(threadId: string): void {
    this.queues.set(threadId, []);
    this.recentContent.set(threadId, new Set());
  }

  /**
   * Get the number of entries in a thread's queue.
   * @param threadId - Discord thread ID
   * @returns Number of queued messages
   */
  size(threadId: string): number {
    return this.queues.get(threadId)?.length ?? 0;
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
pnpm test src/queue/messageQueue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: per-thread message queue with FIFO ordering and deduplication"
```

---

## Round 1 Completion

- [ ] **Integration check after Round 1**

```bash
pnpm tsc --noEmit && pnpm test
```

Expected: All types compile, all tests pass.

- [ ] **Commit round**

```bash
git add -A && git commit -m "feat: round 1 complete - foundation (config, state, utilities, queue)"
```

---

## Round 2: Core Infrastructure

> **Depends on Round 1 exports:** `BotError`, `ErrorCode`, `ConfigLoader`, `StateManager`, `MessageQueue`, all types.

### Task 13: Discord Client Setup

**Files:**
- Create: `src/discord/client.ts`
- Create: `src/discord/client.test.ts`

- [ ] **Step 1: Write failing test for client factory**

Test that `createDiscordClient` returns a configured Client instance with correct intents and that it accepts a token parameter.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement Discord client factory**

Create a `createDiscordClient(token: string)` function that instantiates a `discord.js` Client with intents: `Guilds`, `GuildMessages`, `MessageContent`, `GuildMessageTyping`. Use partials: `Channel`, `Message`, `Thread`.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 14: Command Registry & Deployment

**Files:**
- Create: `src/discord/commands/index.ts`
- Create: `src/discord/deploy.ts`
- Create: `src/discord/deploy.test.ts`

- [ ] **Step 1: Write failing tests**

Test that `getCommandDefinitions()` returns an array of `SlashCommandBuilder` instances, and that `deployCommands(token, guildId, commands)` calls the Discord REST API.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement command registry with all slash command definitions**

Define all 27+ commands using `SlashCommandBuilder` with proper options, choices, and autocomplete flags matching PLAN.md specifications. Group them in a registry Map.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 15: Interaction Handler

**Files:**
- Create: `src/discord/handlers/interactionHandler.ts`
- Create: `src/discord/handlers/interactionHandler.test.ts`

- [ ] **Step 1: Write failing tests**

Test routing: command interactions dispatched to correct handler, autocomplete interactions responded to within 3s, unknown commands return ephemeral error. Test permission check integration.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement interaction router**

Route `ChatInputCommandInteraction` to the command handler, `AutocompleteInteraction` to the autocomplete handler. Check `allowedUsers` before executing. Generate correlation ID.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 16: Message Handler (Thread Passthrough)

**Files:**
- Create: `src/discord/handlers/messageHandler.ts`
- Create: `src/discord/handlers/messageHandler.test.ts`

- [ ] **Step 1: Write failing tests**

Test: ignores bot messages, ignores non-thread messages, checks for pending questions (intercepts answer), checks for active session, queues if busy, forwards if idle. Test context buffer consumption.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement message handler**

Handle `messageCreate` events: filter bots, identify thread, check pending question state, check session state (active/inactive), forward to session bridge or enqueue. Consume context buffer files.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 17: Server Manager

**Files:**
- Create: `src/opencode/serverManager.ts`
- Create: `src/opencode/serverManager.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `ensureRunning(projectPath)` spawns server if not running, returns existing client if running. Port allocation via `net.createServer`. Health check polling. Crash detection via process exit. Idle timer (5min). AutoConnect suppresses idle timer. Graceful shutdown kills processes.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement ServerManager**

Spawn `opencode serve` via `cross-spawn` with `cwd`, allocate free port, wait for health check, track state. Implement idle timer, crash handler, periodic health monitoring (60s, 3 failures = crash). Expose `ensureRunning()`, `getClient()`, `shutdown()`, `shutdownAll()`.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 18: Cache Manager

**Files:**
- Create: `src/opencode/cache.ts`
- Create: `src/opencode/cache.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `refresh(projectPath, client)` fetches agents/models/sessions/MCP status. `getAgents()`, `getModels()`, `getSessions()`, `getMcpStatus()` return cached data. Disk persistence to `.cache/`. Cold cache returns empty arrays.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement CacheManager**

Fetch from SDK v2 API (`client.app.agents()`, `client.config.providers()`, `client.session.list()`, `client.mcp.status()`). Store in-memory Map + write to `.cache/<hash>.json`. Serve from memory on autocomplete calls.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 19: Session Bridge

**Files:**
- Create: `src/opencode/sessionBridge.ts`
- Create: `src/opencode/sessionBridge.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `createSession()` calls SDK and returns session. `sendPrompt()` builds parts array with TextPartInput + FilePartInput. `connectToSession()` replays history, subscribes SSE, handles gap recovery. `abortSession()` calls SDK abort.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement SessionBridge**

Session CRUD via SDK v2. Build prompt `parts` array. Shared connect logic (used by `/connect` and auto-connect): create thread mapping, subscribe SSE, replay history with formatting, gap recovery via deduplication Set.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 20: Stream Handler

**Files:**
- Create: `src/opencode/streamHandler.ts`
- Create: `src/opencode/streamHandler.test.ts`

- [ ] **Step 1: Write failing tests**

Test: subscribes to `client.global.event()`. Accumulates text deltas per partID. Triggers message split at ~1800 chars. Detects tables. Shows tool status. Delegates `question.asked` and `permission.asked`. Throttles edits to ~1s. Handles SSE reconnection (3 retries).

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement StreamHandler**

Subscribe to SSE, filter by directory/sessionID. Accumulate `message.part.delta` text. Smart split at boundaries. Code block continuity. Tool status display (running tools comma-separated). Delegate question/permission events. Throttle Discord edits. 3-retry reconnection.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 21: Question Handler

**Files:**
- Create: `src/opencode/questionHandler.ts`
- Create: `src/opencode/questionHandler.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `handleQuestionEvent()` posts embed with lettered options. `handleQuestionAnswer()` parses letter/text input, validates, collects multi-question answers sequentially. Timeout triggers reject. Invalid input re-shows question.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement QuestionHandler**

Post embeds per question (one at a time for multi-question groups). Parse answers (letter → option label, text when custom allowed). Manage pending state per thread. Call `client.question.reply()` or `client.question.reject()`. Configurable timeout.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 22: Permission Handler

**Files:**
- Create: `src/opencode/permissionHandler.ts`
- Create: `src/opencode/permissionHandler.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `auto` mode immediately replies "always" with no Discord message. `interactive` mode posts embed with buttons. Button clicks call correct reply. 60s timeout auto-rejects.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement PermissionHandler**

Check channel's `permissions` config. Auto → `client.permission.reply({ reply: "always" })`. Interactive → embed with Allow Once/Always/Reject buttons + collector. Timeout → reject + notice.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 23: Table Renderer

**Files:**
- Create: `src/utils/tableRenderer.ts`
- Create: `src/utils/tableRenderer.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `renderTableToPng(markdownTable)` returns a Buffer containing PNG data. Verify output is valid PNG (magic bytes). Test with multi-column tables, special characters.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement table renderer**

Parse markdown table into rows/columns. Generate HTML table string with dark theme CSS (background #2b2d31, text #e0e0e0, grid #40444b). Render via `satori` → SVG, then `@resvg/resvg-js` → PNG Buffer.

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

## Round 2 Completion

- [ ] **Integration check after Round 2**

```bash
pnpm tsc --noEmit && pnpm test
```

- [ ] **Commit round**

```bash
git add -A && git commit -m "feat: round 2 complete - discord core, opencode integration, streaming"
```

---

## Round 3: Commands & Attachments

> **Depends on Round 2 exports:** `ServerManager`, `CacheManager`, `SessionBridge`, `StreamHandler`, `QuestionHandler`, `PermissionHandler`, Discord client, handlers, `MessageQueue`.

### Task 24: Commands Batch 1 — Session Lifecycle

**Files:**
- Create: `src/discord/commands/new.ts`
- Create: `src/discord/commands/connect.ts`
- Create: `src/discord/commands/agent.ts`
- Create: `src/discord/commands/model.ts`
- Create: `src/discord/commands/info.ts`
- Create: `src/discord/commands/end.ts`
- Create: `src/discord/commands/status.ts`
- Create: `src/discord/commands/help.ts`
- Create: Tests for each command

**Per command, follow TDD:**
- [ ] Write failing test (validates args, permission checks, response format, error paths)
- [ ] Verify test fails
- [ ] Implement command handler
- [ ] Verify test passes
- [ ] Commit

**Command specs (from PLAN.md):**
- `/new` — validate permissions, ensure server, create thread + session, send prompt, stream response
- `/connect` — validate permissions, ensure server, verify session unattached, create thread, replay history, gap recovery
- `/agent set` — check allowAgentSwitch + allowedAgents, update state
- `/agent list` — query agents from cache, filter by allowedAgents, format embed
- `/model set` — update state, validate against cache
- `/model list` — query models from cache, format embed grouped by provider
- `/info` — display session details embed (ID, agent, model, status, queue, MCP, tokens, cost)
- `/end` — abort, cleanup, archive, update state
- `/status` — channel-level server + session overview embed
- `/help` — context-aware command list (channel vs thread)

---

### Task 25: Commands Batch 2 — Filesystem & Queue

**Files:**
- Create: `src/discord/commands/git.ts`
- Create: `src/discord/commands/ls.ts`
- Create: `src/discord/commands/cat.ts`
- Create: `src/discord/commands/download.ts`
- Create: `src/discord/commands/queue.ts`
- Create: `src/discord/commands/interrupt.ts`
- Create: Tests for each command

**Per command, follow TDD:**
- [ ] Write failing test
- [ ] Verify test fails
- [ ] Implement command handler
- [ ] Verify test passes
- [ ] Commit

**Command specs:**
- `/git` (9 subcommands) — execFile in project dir, format output, confirmation button for `reset hard`
- `/ls` — safe path resolve, readdir, format with trailing /
- `/cat` — safe path, read file, infer language, fenced code block, truncate ~1800
- `/download` — safe path, AttachmentBuilder
- `/queue list` — display pending messages
- `/queue clear` — clear queue + persist
- `/interrupt` — abort session + clear queue

---

### Task 26: Commands Batch 3 — Advanced Session

**Files:**
- Create: `src/discord/commands/restart.ts`
- Create: `src/discord/commands/mcp.ts`
- Create: `src/discord/commands/diff.ts`
- Create: `src/discord/commands/revert.ts`
- Create: `src/discord/commands/summary.ts`
- Create: `src/discord/commands/fork.ts`
- Create: `src/discord/commands/todo.ts`
- Create: `src/discord/commands/retry.ts`
- Create: `src/discord/commands/context.ts`
- Create: Tests for each command

**Per command, follow TDD:**
- [ ] Write failing test
- [ ] Verify test fails
- [ ] Implement command handler
- [ ] Verify test passes
- [ ] Commit

**Command specs:**
- `/restart` — confirmation button, kill/respawn server, notify threads
- `/mcp list/reconnect/disconnect` — SDK calls, autocomplete from cache
- `/diff` — session.diff(), format as diff code block, split if long
- `/revert` + `/unrevert` — autocomplete last 15 messages, SDK calls
- `/summary` — parse model arg, session.summarize()
- `/fork` — session.fork(), new thread, persist, SSE subscribe, cross-links
- `/todo` — session.todo(), render embed with status indicators
- `/retry` — revert last assistant, resend last user prompt
- `/context add/list/clear` — manage per-thread memory buffer

---

### Task 27: Attachment Handling

**Files:**
- Create: `src/opencode/attachments.ts`
- Create: `src/opencode/attachments.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `downloadAndSave(discordAttachment, projectPath)` downloads URL and saves to `<projectPath>/.opencode/attachments/<timestamp>-<msgId>-<filename>`. `buildFilePartInput(savedPath)` creates correct `file://` URL. `cleanupOld(projectPath, maxAge)` removes files older than TTL. `cleanupSession(projectPath, threadId)` removes session-specific files.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement attachment handler**
- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

## Round 3 Completion

- [ ] **Integration check after Round 3**

```bash
pnpm tsc --noEmit && pnpm test
```

- [ ] **Commit round**

```bash
git add -A && git commit -m "feat: round 3 complete - all commands + attachment handling"
```

---

## Round 4: Integration & Lifecycle

> **Depends on all previous rounds.**

### Task 28: Entry Point & Startup Flow

**Files:**
- Modify: `src/index.ts`
- Create: `src/index.test.ts`

- [ ] **Step 1: Write failing tests for startup sequence**

Test: loads config, loads state, recovers servers, recovers sessions, starts eager servers (autoConnect), connects Discord, syncs commands.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement startup orchestration**

Wire all modules together. Implement the full Bot Startup Recovery Flow from PLAN.md (preflight check, state load, config load, server recovery, session recovery, queue recovery, eager start, Discord connect).

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 29: Hot-Reload Watcher

**Files:**
- Modify: `src/config/loader.ts` (add chokidar watch)
- Create: `src/config/watcher.test.ts`

- [ ] **Step 1: Write failing tests**

Test: file change triggers reload, invalid config is rejected (keeps old), channel removal triggers session cleanup.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement hot-reload with chokidar**
- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 30: Lifecycle Events

**Files:**
- Modify: `src/discord/client.ts` (add event listeners)
- Create: `src/lifecycle.test.ts`

- [ ] **Step 1: Write failing tests**

Test: thread delete → session ended. Bot shutdown → abort all + kill servers. Inactivity check → archive + mark inactive. SIGINT/SIGTERM handling.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement lifecycle event handlers**

Thread delete handler. 30-minute inactivity timer. SIGINT/SIGTERM graceful shutdown (abort sessions, kill processes, save state, disconnect Discord).

- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 31: Auto-Connect Wiring

**Files:**
- Modify: `src/opencode/streamHandler.ts` (add session.created handling)
- Create: `src/opencode/autoConnect.test.ts`

- [ ] **Step 1: Write failing tests**

Test: `session.created` event → finds autoConnect channel → creates thread → connects session. Already-attached sessions are skipped. SSE reconnection gap recovery (session.list diff). Bot restart catches missed sessions.

- [ ] **Step 2: Verify test fails**
- [ ] **Step 3: Implement auto-connect logic**
- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 32: End-to-End Integration Tests

**Files:**
- Create: `tests/integration/startup.test.ts`
- Create: `tests/integration/session-flow.test.ts`
- Create: `tests/integration/auto-connect.test.ts`

- [ ] **Write integration tests covering:**
  - Full startup → config load → server spawn → session create → stream → end
  - Connect to existing session → history replay → gap recovery
  - Auto-connect flow (session.created → thread → connected)
  - Restart flow (kill → respawn → reconnect)
  - Error paths (invalid config, missing server, permission denied)

- [ ] **Verify all tests pass**

```bash
pnpm test
```

- [ ] **Final commit**

```bash
git add -A && git commit -m "feat: round 4 complete - integration, lifecycle, auto-connect, e2e tests"
```

---

## Round 4 Completion

- [ ] **Final verification**

```bash
pnpm tsc --noEmit && pnpm test
```

All types compile. All tests pass. Ready for `/review` and `/security-review`.

---

## Cross-Module Interfaces

### Round 1 Exports (consumed by Round 2+)

| Module | Export | Type |
|--------|--------|------|
| `src/utils/errors.ts` | `BotError`, `ErrorCode` | Class + const enum |
| `src/utils/logger.ts` | `createLogger`, `generateCorrelationId` | Functions |
| `src/utils/filesystem.ts` | `resolveSafePath`, `listDirectory`, `inferLanguage` | Functions |
| `src/utils/permissions.ts` | `checkUserAllowed`, `checkAgentAllowed` | Functions |
| `src/utils/formatter.ts` | `splitMessage`, `detectTable`, `formatHistoryMessage` | Functions |
| `src/config/types.ts` | `BotConfig`, `ServerConfig`, `ChannelConfig` | Types |
| `src/config/schema.ts` | `configSchema`, `ValidatedConfig` | Schema + type |
| `src/config/loader.ts` | `ConfigLoader` | Class |
| `src/state/types.ts` | `BotState`, `ServerState`, `SessionState`, `QueueEntry`, `EMPTY_STATE` | Types + const |
| `src/state/manager.ts` | `StateManager` | Class |
| `src/queue/messageQueue.ts` | `MessageQueue` | Class |

### Round 2 Exports (consumed by Round 3+)

| Module | Export | Type |
|--------|--------|------|
| `src/discord/client.ts` | `createDiscordClient` | Function |
| `src/discord/deploy.ts` | `deployCommands` | Function |
| `src/discord/commands/index.ts` | `commandRegistry` | Map |
| `src/discord/handlers/interactionHandler.ts` | `handleInteraction` | Function |
| `src/discord/handlers/messageHandler.ts` | `handleMessage` | Function |
| `src/opencode/serverManager.ts` | `ServerManager` | Class |
| `src/opencode/cache.ts` | `CacheManager` | Class |
| `src/opencode/sessionBridge.ts` | `SessionBridge` | Class |
| `src/opencode/streamHandler.ts` | `StreamHandler` | Class |
| `src/opencode/questionHandler.ts` | `QuestionHandler` | Class |
| `src/opencode/permissionHandler.ts` | `PermissionHandler` | Class |
| `src/utils/tableRenderer.ts` | `renderTableToPng` | Function |

---

## Sub-agent Prompt Guidelines

Each sub-agent dispatched via `/implement` must receive:

1. **Full task text** — copied inline, never a file reference
2. **TypeScript interfaces from prior rounds** — read actual source files and inline the relevant types
3. **Exact file paths owned** — only modify these files
4. **Instructions:**
   - "Follow TDD: write failing test FIRST, verify it fails, then implement minimal code to pass."
   - "Load relevant skills: `sdk-reference`, `discord-patterns`, `error-handling`, `module-boundaries`, `process-lifecycle`"
   - "Run `pnpm tsc --noEmit && pnpm test` at the end to verify."
   - "Report: files created/modified, exported interfaces, test results, concerns."
5. **Context:** One-paragraph summary of where this task fits in the overall system
