import type { Logger } from "../interfaces/logger.js";

export class NoopLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}
