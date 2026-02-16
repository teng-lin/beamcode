import { useStore } from "../store";
import { formatElapsed, formatTokens } from "../utils/format";
import { MarkdownContent } from "./MarkdownContent";

interface StreamingIndicatorProps {
  sessionId: string;
}

function formatStreamingStats(startedAt: number | null, outputTokens: number): string {
  const parts: string[] = [];
  if (startedAt) parts.push(formatElapsed(startedAt));
  if (outputTokens > 0) parts.push(`${formatTokens(outputTokens)} tokens`);
  if (parts.length === 0) return "";
  return `(${parts.join(" | ")})`;
}

export function StreamingIndicator({ sessionId }: StreamingIndicatorProps) {
  const data = useStore((s) => s.sessionData[sessionId]);

  if (!data?.streaming && !data?.streamingStartedAt) return null;

  const stats = formatStreamingStats(data.streamingStartedAt, data.streamingOutputTokens);

  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      {data.streaming && <MarkdownContent content={data.streaming} />}

      <div className="flex items-center gap-2 py-1 text-xs text-bc-text-muted">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-bc-accent" />
        <span>Generating...</span>
        {stats && <span>{stats}</span>}
      </div>
    </div>
  );
}
