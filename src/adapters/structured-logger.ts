import type { Logger } from "../interfaces/logger.js";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "debug",
  [LogLevel.INFO]: "info",
  [LogLevel.WARN]: "warn",
  [LogLevel.ERROR]: "error",
};

export interface StructuredLoggerOptions {
  writer?: (line: string) => void;
  level?: LogLevel;
  component?: string;
}

export class StructuredLogger implements Logger {
  private writer: (line: string) => void;
  private level: LogLevel;
  private component: string | undefined;

  constructor(options: StructuredLoggerOptions = {}) {
    this.writer = options.writer ?? ((line) => process.stderr.write(`${line}\n`));
    this.level = options.level ?? LogLevel.DEBUG;
    this.component = options.component;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.emit(LogLevel.DEBUG, msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.emit(LogLevel.INFO, msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.emit(LogLevel.WARN, msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.emit(LogLevel.ERROR, msg, ctx);
  }

  private emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (level < this.level) return;

    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: LEVEL_NAMES[level],
      msg,
    };

    if (this.component) entry.component = this.component;

    if (ctx) {
      for (const [key, value] of Object.entries(ctx)) {
        if (value instanceof Error) {
          entry[key] = value.message;
          entry[`${key}Stack`] = value.stack;
        } else {
          entry[key] = value;
        }
      }
    }

    try {
      this.writer(JSON.stringify(entry));
    } catch {
      // Circular reference or serialization failure — emit safe fallback
      this.writer(
        JSON.stringify({ time: entry.time, level: entry.level, msg, serializationError: true }),
      );
    }
  }
}
