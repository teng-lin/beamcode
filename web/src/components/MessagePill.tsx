import { useState } from "react";

export interface FlowMessage {
  id: string;
  direction: "out" | "in";
  type: string;
  payload: unknown;
  timestamp: number;
  wallTime: number;
  pairedId?: string;
  groupIds?: string[];
  // Translation boundary metadata (for message flow visualization)
  boundary?: "T1" | "T2" | "T3" | "T4";
  translator?: string;
  nativeFormat?: { format: string; body: unknown };
  traceId?: string;
}

const COLOR_MAP: Record<string, string> = {
  assistant: "#F59E0B",
  stream_event: "#22D3EE",
  tool_progress: "#14B8A6",
  tool_use_summary: "#6EE7B7",
  status_change: "#A78BFA",
  permission_request: "#F97316",
  result: "#84CC16",
  cli_connected: "#94A3B8",
  cli_disconnected: "#F87171",
  error: "#EF4444",
  user_message: "#F8FAFC",
  message_queued: "#C084FC",
  permission_response: "#FED7AA",
  interrupt: "#EF4444",
  slash_command: "#38BDF8",
  queue_message: "#C084FC",
  update_queued_message: "#E9D5FF",
  cancel_queued_message: "#F87171",
  adapter_drop: "#EF4444",
  translation_event: "#8B5CF6",
};

const DEFAULT_COLOR = "#71717A";

export function getColor(type: string): string {
  return COLOR_MAP[type] ?? DEFAULT_COLOR;
}

/**
 * Generate a consistent color from a traceId for visual correlation.
 * Uses a simple hash to pick from a palette of distinct colors.
 */
function getTraceColor(traceId: string): string {
  const colors = [
    "#22D3EE", // cyan
    "#F59E0B", // amber
    "#A78BFA", // purple
    "#FB923C", // orange
    "#34D399", // emerald
    "#F472B6", // pink
    "#FACC15", // yellow
    "#60A5FA", // blue
    "#FB7185", // rose
    "#A3E635", // lime
  ];

  let hash = 0;
  for (let i = 0; i < traceId.length; i++) {
    hash = (hash << 5) - hash + traceId.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }

  return colors[Math.abs(hash) % colors.length];
}

interface MessagePillProps {
  message: FlowMessage;
  detailLevel: "compact" | "detailed";
  dimmed: boolean;
  highlighted?: boolean;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}

export function MessagePill({
  message,
  detailLevel,
  dimmed,
  highlighted = false,
  onHoverStart,
  onHoverEnd,
}: MessagePillProps) {
  const [expanded, setExpanded] = useState(false);
  const [boundaryExpanded, setBoundaryExpanded] = useState(false);
  const color = getColor(message.type);
  const payloadStr = JSON.stringify(message.payload);
  const preview = payloadStr.length > 80 ? `${payloadStr.slice(0, 80)}…` : payloadStr;

  const showBoundary = detailLevel === "detailed" && message.boundary;
  const traceColor = message.traceId ? getTraceColor(message.traceId) : null;
  const truncatedTraceId = message.traceId?.slice(0, 8);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pill is a visual dev tool element, not interactive UI
    <div
      data-flow-id={message.id}
      data-trace-id={message.traceId}
      className={`flex min-w-0 flex-col gap-1 overflow-hidden rounded px-2 py-1.5 transition-all ${
        dimmed ? "opacity-30" : ""
      } ${highlighted ? "ring-2 ring-offset-1 ring-offset-[#0A0B0D]" : "bg-bc-surface"}`}
      style={{
        borderLeft: `3px solid ${color}`,
        ...(highlighted && traceColor
          ? { backgroundColor: `${traceColor}15`, ringColor: traceColor }
          : {}),
      }}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div className="flex items-center gap-2 font-mono-code text-[11px]">
        <span className="font-bold text-bc-text" style={{ color }}>
          {message.type}
        </span>
        {showBoundary && (
          <span className="rounded bg-[#8B5CF6]/20 px-1 py-0.5 text-[9px] font-bold text-[#8B5CF6]">
            {message.boundary}
          </span>
        )}
        {message.traceId && (
          <span
            className="rounded px-1 py-0.5 text-[9px] font-mono-code font-bold opacity-80"
            style={{ backgroundColor: `${traceColor}30`, color: traceColor ?? undefined }}
            title={`Trace ID: ${message.traceId}`}
          >
            {truncatedTraceId}
          </span>
        )}
        <span className="text-bc-text-muted">+{message.timestamp}ms</span>
        <span className="text-bc-text-muted">{message.direction === "out" ? "↗" : "↙"}</span>
        <button
          type="button"
          className="ml-auto text-bc-text-muted hover:text-bc-text"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "[▴]" : "[▾]"}
        </button>
      </div>
      {expanded ? (
        <pre className="whitespace-pre-wrap break-all font-mono-code text-[10px] leading-relaxed text-bc-text-muted">
          {JSON.stringify(message.payload, null, 2)}
        </pre>
      ) : (
        <span className="truncate font-mono-code text-[10px] text-bc-text-muted">{preview}</span>
      )}

      {/* Boundary details (detailed mode only) */}
      {showBoundary && message.nativeFormat && (
        <div className="mt-1 border-t border-bc-border/30 pt-1">
          <button
            type="button"
            onClick={() => setBoundaryExpanded((e) => !e)}
            className="w-full text-left font-mono-code text-[9px] text-bc-text-muted/70 hover:text-bc-text-muted"
          >
            {boundaryExpanded ? "▼" : "▶"} {message.translator} → {message.nativeFormat.format}
          </button>
          {boundaryExpanded && (
            <div className="mt-1">
              <pre className="max-h-32 overflow-auto rounded bg-bc-code-bg p-2 font-mono-code text-[9px] leading-relaxed text-bc-text-muted/80">
                {JSON.stringify(message.nativeFormat.body, null, 2).slice(0, 500)}
                {JSON.stringify(message.nativeFormat.body).length > 500 && "…"}
              </pre>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(JSON.stringify(message.nativeFormat!.body, null, 2))
                }
                className="mt-1 font-mono-code text-[9px] text-[#8B5CF6] hover:underline"
              >
                Copy full
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
