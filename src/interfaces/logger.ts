/**
 * Minimal structured logger interface.
 * Adapters (ConsoleLogger, StructuredLogger) implement this; core code programs to it.
 * @module
 */

/** Structured logger with optional debug level. */
export interface Logger {
  debug?(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}
