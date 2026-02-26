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
};

const DEFAULT_COLOR = "#71717A";

export function getColor(type: string): string {
  return COLOR_MAP[type] ?? DEFAULT_COLOR;
}

interface MessagePillProps {
  message: FlowMessage;
  dimmed: boolean;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}

export function MessagePill({ message, dimmed, onHoverStart, onHoverEnd }: MessagePillProps) {
  const [expanded, setExpanded] = useState(false);
  const color = getColor(message.type);
  const payloadStr = JSON.stringify(message.payload);
  const preview = payloadStr.length > 80 ? `${payloadStr.slice(0, 80)}…` : payloadStr;

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
    </div>
  );
}
