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

function secondsSince(ts: number): number {
  return Math.floor((Date.now() - ts) / 1000);
}

/** Ticks every second while startedAt is non-null, returning elapsed seconds. */
function useElapsed(startedAt: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() =>
    startedAt !== null ? secondsSince(startedAt) : null,
  );

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(null);
      return;
    }

    // Compute immediately so we don't wait 1s for the first value
    setElapsed(secondsSince(startedAt));

    const id = setInterval(() => {
      setElapsed(secondsSince(startedAt));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return elapsed;
}

export function StreamingIndicator({ sessionId }: StreamingIndicatorProps) {
  const streaming = useStore((s) => s.sessionData[sessionId]?.streaming ?? null);
  const streamingThinking = useStore((s) => s.sessionData[sessionId]?.streamingThinking ?? null);
  const streamingStartedAt = useStore((s) => s.sessionData[sessionId]?.streamingStartedAt ?? null);
  const streamingOutputTokens = useStore(
    (s) => s.sessionData[sessionId]?.streamingOutputTokens ?? 0,
  );
  const sessionStatus = useStore((s) => s.sessionData[sessionId]?.sessionStatus ?? null);
  const retryInfo = useStore((s) => s.sessionData[sessionId]?.retryInfo ?? null);

  const elapsed = useElapsed(streamingStartedAt);
  const [stopping, setStopping] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset stopping on session switch
  useEffect(() => {
    setStopping(false);
  }, [sessionId]);

  useEffect(() => {
    if (!streaming && !streamingStartedAt && sessionStatus !== "running") setStopping(false);
  }, [streaming, streamingStartedAt, sessionStatus]);

  const handleStop = useCallback(() => {
    send({ type: "interrupt" }, sessionId);
    setStopping(true);
  }, [sessionId]);

  if (sessionStatus === "retry" && retryInfo) {
    return (
      <div className="mx-auto w-full max-w-3xl px-3">
        <div className="flex items-center gap-2 py-1.5 text-xs text-bc-error">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-bc-error" />
          <span>{retryInfo.message}</span>
        </div>
      </div>
    );
  }

  if (!streaming && !streamingStartedAt && sessionStatus !== "running") return null;

  const stats = formatStreamingStats(elapsed, streamingOutputTokens);
  const showStopButton = sessionStatus === "running" && !stopping;

  const dotClass = `inline-block h-1.5 w-1.5 rounded-full ${stopping ? "bg-bc-text-muted" : "animate-pulse bg-bc-accent shadow-[0_0_6px_var(--color-bc-accent-glow)]"}`;

  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      {streamingThinking && (
        <div className="mb-1.5 rounded-lg border border-bc-border/40 bg-bc-surface/50">
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-bc-text-muted">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              className="flex-shrink-0"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1" opacity="0.5" />
              <circle cx="4.5" cy="5" r="1" fill="currentColor" opacity="0.4" />
              <circle cx="7.5" cy="5" r="1" fill="currentColor" opacity="0.4" />
              <path
                d="M4.5 7.5Q6 8.5 7.5 7.5"
                stroke="currentColor"
                strokeWidth="0.8"
                fill="none"
                opacity="0.4"
              />
            </svg>
            <span className="italic opacity-70">Thinking...</span>
          </div>
          <pre className="max-h-60 overflow-auto border-t border-bc-border/30 p-3 font-mono-code text-xs text-bc-text-muted/80 leading-relaxed">
            {streamingThinking}
          </pre>
        </div>
      )}
      {streaming && <MarkdownContent content={streaming} />}

      <div className="flex items-center gap-2 py-1.5 text-xs text-bc-text-muted">
        <span className={dotClass} />
        <span className={stopping ? undefined : "text-bc-accent/80"}>
          {stopping ? "Stopping..." : "Generating..."}
        </span>

        {stats && <span className="tabular-nums">{stats}</span>}

        {showStopButton && (
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
