/**
 * Console-based Logger implementation.
 * Prefixes all output with a configurable tag (default: "claude-ws").
 */

import type { Logger } from "../interfaces/logger.js";

export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix = "claude-ws") {
    this.prefix = prefix;
  }

  private log(
    method: "debug" | "log" | "warn" | "error",
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    const formatted = `[${this.prefix}] ${msg}`;
    if (ctx) {
      console[method](formatted, ctx);
    } else {
      console[method](formatted);
    }
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.log("debug", msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.log("log", msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.log("warn", msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.log("error", msg, ctx);
  }
}
