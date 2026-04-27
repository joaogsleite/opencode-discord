/**
 * Structured logger for module-scoped JSON log entries.
 */
export interface Logger {
  /**
   * Log a debug message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  debug(msg: string, meta?: Record<string, unknown>): void;

  /**
   * Log an info message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  info(msg: string, meta?: Record<string, unknown>): void;

  /**
   * Log a warning message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  warn(msg: string, meta?: Record<string, unknown>): void;

  /**
   * Log an error message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
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
  const log = (
    level: string,
    msg: string,
    meta: Record<string, unknown> = {},
  ): void => {
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
