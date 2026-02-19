import type { Logger } from "../interfaces/logger.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Register SIGTERM and SIGINT handlers that run a cleanup function before exiting.
 * Force-exits after `timeoutMs` if cleanup stalls.
 */
export function registerSignalHandlers(
  cleanup: () => Promise<void>,
  logger: Logger,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): void {
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
