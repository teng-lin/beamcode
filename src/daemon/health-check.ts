import type { Logger } from "../interfaces/logger.js";
import { updateHeartbeat } from "./state-file.js";

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Start a periodic heartbeat that updates the daemon state file.
 * Returns the timer ref (already unref'd so it won't keep the process alive).
 */
export function startHealthCheck(
  statePath: string,
  logger: Logger,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  let consecutiveFailures = 0;

  const timer = setInterval(() => {
    updateHeartbeat(statePath, logger)
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((err) => {
        consecutiveFailures++;
        if (consecutiveFailures % 3 === 0) {
          logger.error("Heartbeat failed consecutively", {
            component: "health-check",
            consecutiveFailures,
            error: err,
          });
        }
      });
  }, intervalMs);

  timer.unref();
  return timer;
}
