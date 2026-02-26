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

interface MessagePillProps {
  message: FlowMessage;
  detailLevel: "compact" | "detailed";
  dimmed: boolean;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}

export function MessagePill({
  message,
  detailLevel,
  dimmed,
  onHoverStart,
  onHoverEnd,
}: MessagePillProps) {
  const [expanded, setExpanded] = useState(false);
  const [boundaryExpanded, setBoundaryExpanded] = useState(false);
  const color = getColor(message.type);
  const payloadStr = JSON.stringify(message.payload);
  const preview = payloadStr.length > 80 ? `${payloadStr.slice(0, 80)}…` : payloadStr;

  const showBoundary = detailLevel === "detailed" && message.boundary;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pill is a visual dev tool element, not interactive UI
    <div
      data-flow-id={message.id}
      className={`flex min-w-0 flex-col gap-1 overflow-hidden rounded bg-bc-surface px-2 py-1.5 ${dimmed ? "opacity-30" : ""}`}
      style={{ borderLeft: `3px solid ${color}` }}
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
