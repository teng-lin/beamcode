import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { formatElapsedSeconds, formatTokens } from "../utils/format";
import { send } from "../ws";
import { MarkdownContent } from "./MarkdownContent";

interface StreamingIndicatorProps {
  sessionId: string;
}

function formatStreamingStats(elapsed: number | null, outputTokens: number): string {
  const parts: string[] = [];
  if (elapsed !== null) parts.push(formatElapsedSeconds(elapsed));
  if (outputTokens > 0) parts.push(`${formatTokens(outputTokens)} tokens`);
  if (parts.length === 0) return "";
  return `(${parts.join(" | ")})`;
}

/** Ticks every second while startedAt is non-null, returning elapsed seconds. */
function useElapsed(startedAt: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() =>
    startedAt !== null ? Math.floor((Date.now() - startedAt) / 1000) : null,
  );

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(null);
      return;
    }

    // Compute immediately so we don't wait 1s for the first value
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));

    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return elapsed;
}

export function StreamingIndicator({ sessionId }: StreamingIndicatorProps) {
  const streaming = useStore((s) => s.sessionData[sessionId]?.streaming ?? null);
  const streamingStartedAt = useStore((s) => s.sessionData[sessionId]?.streamingStartedAt ?? null);
  const streamingOutputTokens = useStore(
    (s) => s.sessionData[sessionId]?.streamingOutputTokens ?? 0,
  );
  const sessionStatus = useStore((s) => s.sessionData[sessionId]?.sessionStatus ?? null);

  const elapsed = useElapsed(streamingStartedAt);
  const [stopping, setStopping] = useState(false);

  // Reset stopping state when streaming clears (component is about to unmount)
  useEffect(() => {
    if (!streaming && !streamingStartedAt) setStopping(false);
  }, [streaming, streamingStartedAt]);

  const handleStop = useCallback(() => {
    send({ type: "interrupt" }, sessionId);
    setStopping(true);
  }, [sessionId]);

  if (!streaming && !streamingStartedAt) return null;

  const stats = formatStreamingStats(elapsed, streamingOutputTokens);

  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      {streaming && <MarkdownContent content={streaming} />}

      <div className="flex items-center gap-2 py-1.5 text-xs text-bc-text-muted">
        {stopping ? (
          <>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-bc-text-muted" />
            <span>Stopping...</span>
          </>
        ) : (
          <>
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-bc-accent shadow-[0_0_6px_var(--color-bc-accent-glow)]" />
            <span className="text-bc-accent/80">Generating...</span>
          </>
        )}
        {stats && <span className="tabular-nums">{stats}</span>}

        {sessionStatus === "running" && !stopping && (
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-bc-text-muted transition-colors hover:bg-bc-error/10 hover:text-bc-error"
              aria-label="Stop generation"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect width="14" height="14" rx="2" />
              </svg>
              <span>Stop</span>
            </button>
            <kbd className="rounded border border-bc-border-subtle bg-bc-surface-2 px-1 py-0.5 font-mono text-[10px] text-bc-text-muted">
              Esc
            </kbd>
          </div>
        )}
      </div>
    </div>
  );
}
