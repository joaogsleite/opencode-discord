import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      expect.stringContaining('"level":"debug"'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"module":"TestModule"'),
    );
  });

  it('logs info messages', () => {
    const logger = createLogger('TestModule');
    logger.info('info message', { correlationId: 'abc-123' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"info"'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"module":"TestModule"'),
    );
  });

  it('logs warn messages', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const logger = createLogger('TestModule');
    logger.warn('warning', { reason: 'test' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"warn"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"module":"TestModule"'),
    );
  });

  it('logs error messages', () => {
    const errorSpy = vi.spyOn(console, 'error');
    const logger = createLogger('TestModule');
    logger.error('error occurred', { error: 'boom' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"error"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"module":"TestModule"'),
    );
  });
});
