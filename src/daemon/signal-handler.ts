import { noopLogger } from "../adapters/noop-logger.js";
import type { Logger } from "../interfaces/logger.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SignalHandlerOptions {
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Register SIGTERM and SIGINT handlers that run a cleanup function before exiting.
 * Force-exits after `timeoutMs` if cleanup stalls.
 */
export function registerSignalHandlers(
  cleanup: () => Promise<void>,
  options: SignalHandlerOptions = {},
): void {
  const logger = options.logger ?? noopLogger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let shuttingDown = false;

  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceTimer = setTimeout(() => {
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    cleanup()
      .catch((err) => {
        logger.error("Shutdown cleanup failed", { component: "daemon", error: err });
      })
      .finally(() => {
        clearTimeout(forceTimer);
        process.exit(0);
      });
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
