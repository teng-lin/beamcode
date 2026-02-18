import { useEffect, useState } from "react";
import { useStore } from "../store";
import { formatElapsedSeconds, formatTokens } from "../utils/format";
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
  const streamingStartedAt = useStore(
    (s) => s.sessionData[sessionId]?.streamingStartedAt ?? null,
  );
  const streamingOutputTokens = useStore(
    (s) => s.sessionData[sessionId]?.streamingOutputTokens ?? 0,
  );

  const elapsed = useElapsed(streamingStartedAt);

  if (!streaming && !streamingStartedAt) return null;

  const stats = formatStreamingStats(elapsed, streamingOutputTokens);

  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      {streaming && <MarkdownContent content={streaming} />}

      <div className="flex items-center gap-2 py-1.5 text-xs text-bc-text-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-bc-accent shadow-[0_0_6px_var(--color-bc-accent-glow)]" />
        <span className="text-bc-accent/80">Generating...</span>
        {stats && <span className="tabular-nums">{stats}</span>}
      </div>
    </div>
  );
}
