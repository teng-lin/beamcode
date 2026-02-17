import { useCallback, useEffect, useRef, useState } from "react";
import { currentData, useStore } from "../store";
import { connectToSession } from "../ws";

interface ConnectionBannerProps {
  reconnectAttempt?: number;
}

function useCountdown(targetMs: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (targetMs == null) {
      setRemaining(null);
      return;
    }
    const target = targetMs;
    function tick() {
      const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setRemaining(left);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs]);

  return remaining;
}

const BANNER_BASE = "flex items-center justify-center gap-2 border-b px-3 py-2 text-xs";
const WARNING_BANNER = `${BANNER_BASE} border-bc-warning/20 bg-bc-warning/10 text-bc-warning`;
const ERROR_BANNER = `${BANNER_BASE} border-bc-error/20 bg-bc-error/10 text-bc-error`;

function PulseDot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bc-warning" />;
}

export function ConnectionBanner({ reconnectAttempt }: ConnectionBannerProps) {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const circuitBreaker = useStore((s) => currentData(s)?.state?.circuitBreaker ?? null);
  const watchdog = useStore((s) => currentData(s)?.state?.watchdog ?? null);

  // Compute countdown targets — stabilize with useRef to avoid re-render loops from Date.now()
  const breakerEndRef = useRef<{ key: string; ms: number } | null>(null);
  const breakerKey =
    circuitBreaker?.state === "open" && circuitBreaker.recoveryTimeRemainingMs > 0
      ? `${circuitBreaker.state}-${circuitBreaker.failureCount}-${circuitBreaker.recoveryTimeRemainingMs}`
      : "";
  if (breakerKey && breakerEndRef.current?.key !== breakerKey) {
    breakerEndRef.current = {
      key: breakerKey,
      ms: Date.now() + (circuitBreaker?.recoveryTimeRemainingMs ?? 0),
    };
  } else if (!breakerKey) {
    breakerEndRef.current = null;
  }
  const breakerEndMs = breakerEndRef.current?.ms ?? null;
  const watchdogEndMs = watchdog ? watchdog.startedAt + watchdog.gracePeriodMs : null;

  const breakerCountdown = useCountdown(breakerEndMs);
  const watchdogCountdown = useCountdown(watchdogEndMs);

  const handleRetry = useCallback(() => {
    if (currentSessionId) {
      connectToSession(currentSessionId);
    }
  }, [currentSessionId]);

  // Circuit breaker open — show protection banner
  if (circuitBreaker?.state === "open") {
    return (
      <div className={ERROR_BANNER} role="alert">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 1.5L1 12.5h12L7 1.5z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M7 5.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="7" cy="10.5" r="0.6" fill="currentColor" />
        </svg>
        <span>
          CLI restart protection active — cooling down
          {breakerCountdown != null && breakerCountdown > 0 && (
            <span className="ml-1 font-medium">({breakerCountdown}s remaining)</span>
          )}
        </span>
        <span className="ml-1 text-bc-text-muted">({circuitBreaker.failureCount} failures)</span>
      </div>
    );
  }

  // Circuit breaker half_open — testing stability
  if (circuitBreaker?.state === "half_open") {
    return (
      <div className={WARNING_BANNER} role="alert">
        <PulseDot />
        <span>Testing connection stability...</span>
      </div>
    );
  }

  // Watchdog active -- show countdown
  if (watchdog && watchdogCountdown != null && watchdogCountdown > 0) {
    return (
      <div className={WARNING_BANNER} role="alert">
        <PulseDot />
        <span>Waiting for CLI to reconnect ({watchdogCountdown}s remaining)...</span>
      </div>
    );
  }

  // Watchdog expired
  if (watchdog && watchdogCountdown != null && watchdogCountdown <= 0) {
    return (
      <div className={WARNING_BANNER} role="alert">
        <PulseDot />
        <span>CLI did not reconnect — relaunching...</span>
      </div>
    );
  }

  // Default: simple disconnection banner
  return (
    <div className={WARNING_BANNER} role="alert">
      <PulseDot />
      <span>
        CLI disconnected — waiting for reconnection
        {reconnectAttempt != null && reconnectAttempt > 0 && (
          <span className="ml-1 text-bc-text-muted">(attempt {reconnectAttempt})</span>
        )}
      </span>
      <button
        type="button"
        onClick={handleRetry}
        className="ml-2 rounded bg-bc-warning/20 px-2 py-0.5 text-xs font-medium text-bc-warning transition-colors hover:bg-bc-warning/30"
        aria-label="Retry connection"
      >
        Retry
      </button>
    </div>
  );
}
