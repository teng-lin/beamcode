import { updateHeartbeat } from "./state-file.js";

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Start a periodic heartbeat that updates the daemon state file.
 * Returns the timer ref (already unref'd so it won't keep the process alive).
 */
export function startHealthCheck(
  statePath: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    updateHeartbeat(statePath).catch(() => {
      // Heartbeat failure is non-fatal — the next tick will retry.
    });
  }, intervalMs);

  timer.unref();
  return timer;
}
