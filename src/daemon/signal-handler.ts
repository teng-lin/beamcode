const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Register SIGTERM and SIGINT handlers that run a cleanup function before exiting.
 * Force-exits after `timeoutMs` if cleanup stalls.
 */
export function registerSignalHandlers(
  cleanup: () => Promise<void>,
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
      .catch(() => {
        // Best-effort cleanup — exit regardless.
      })
      .finally(() => {
        clearTimeout(forceTimer);
        process.exit(0);
      });
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
