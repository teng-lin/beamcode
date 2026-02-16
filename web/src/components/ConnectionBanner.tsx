import { useCallback } from "react";
import { useStore } from "../store";
import { connectToSession } from "../ws";

interface ConnectionBannerProps {
  reconnectAttempt?: number;
}

export function ConnectionBanner({ reconnectAttempt }: ConnectionBannerProps) {
  const currentSessionId = useStore((s) => s.currentSessionId);

  const handleRetry = useCallback(() => {
    if (currentSessionId) {
      connectToSession(currentSessionId);
    }
  }, [currentSessionId]);

  return (
    <div
      className="flex items-center justify-center gap-2 border-b border-bc-warning/20 bg-bc-warning/10 px-3 py-2 text-xs text-bc-warning"
      role="alert"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bc-warning" />
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
