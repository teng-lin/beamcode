import type { Logger } from "../interfaces/logger.js";

export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Shared singleton — use as the default when no logger is injected. */
export const noopLogger: Logger = new NoopLogger();
