import { memo } from "react";
import { type SdkSessionInfo, useStore } from "../store";
import { cwdBasename } from "../utils/format";

const ADAPTER_COLORS: Record<string, string> = {
  claude: "bg-bc-adapter-claude",
  codex: "bg-bc-adapter-codex",
  continue: "bg-bc-adapter-continue",
  gemini: "bg-bc-adapter-gemini",
};

function adapterColor(info?: SdkSessionInfo): string {
  const type = info?.adapterType ?? "default";
  return ADAPTER_COLORS[type] ?? "bg-bc-adapter-default";
}

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running: { dot: "bg-bc-success animate-pulse", label: "Running" },
  compacting: { dot: "border border-bc-warning animate-spin rounded-sm", label: "Compacting" },
  idle: { dot: "bg-bc-success", label: "Idle" },
  connected: { dot: "bg-bc-success", label: "Connected" },
  starting: { dot: "bg-bc-warning animate-pulse", label: "Starting" },
};

const STATUS_DEFAULT = { dot: "border border-bc-text-muted/50", label: "Offline" };

function StatusDot({ status }: { status: string | null }) {
  const { dot, label } = (status ? STATUS_STYLES[status] : null) ?? STATUS_DEFAULT;
  return (
    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dot}`} role="img" aria-label={label} />
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Individual session row — subscribes only to its own status (primitive selector). */
const SessionItem = memo(function SessionItem({
  info,
  isActive,
  onSelect,
}: {
  info: SdkSessionInfo;
  isActive: boolean;
  onSelect: () => void;
}) {
  // Primitive return (string | null) — stable with Object.is, no derived objects.
  const sessionStatus = useStore((s) => s.sessionData[info.sessionId]?.sessionStatus ?? null);
  const status = sessionStatus ?? info.state;
  const name = info.name ?? cwdBasename(info.cwd ?? "untitled");

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
        isActive
          ? "border-l-2 border-bc-accent bg-bc-active"
          : "border-l-2 border-transparent hover:bg-bc-hover"
      }`}
      aria-current={isActive ? "page" : undefined}
    >
      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${adapterColor(info)}`} />
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-sm ${isActive ? "font-medium text-bc-text" : "text-bc-text-muted group-hover:text-bc-text"}`}
        >
          {name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-bc-text-muted/70">
          <StatusDot status={status} />
          <span>{formatTime(info.createdAt)}</span>
        </div>
      </div>
    </button>
  );
});

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);

  const sessionList = Object.values(sessions)
    .filter(
      (s): s is SdkSessionInfo =>
        s != null && typeof s.sessionId === "string" && typeof s.createdAt === "number",
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <aside className="flex h-full w-[260px] flex-shrink-0 flex-col border-r border-bc-border bg-bc-sidebar max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-bc-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-bc-accent/15">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 1L12 4v6l-5 3-5-3V4l5-3z"
                stroke="var(--color-bc-accent)"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle cx="7" cy="7" r="1.5" fill="var(--color-bc-accent)" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-bc-text">BeamCode</span>
        </div>
        <button
          type="button"
          className="flex h-6 items-center rounded-md bg-bc-surface-2 px-2 text-[11px] text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
          aria-label="New session"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="currentColor"
            className="mr-1"
            aria-hidden="true"
          >
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
          New
        </button>
      </div>

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto py-1.5" aria-label="Sessions">
        {sessionList.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-bc-text-muted">No sessions</div>
        ) : (
          sessionList.map((info) => (
            <SessionItem
              key={info.sessionId}
              info={info}
              isActive={info.sessionId === currentSessionId}
              onSelect={() => setCurrentSession(info.sessionId)}
            />
          ))
        )}
      </nav>
    </aside>
  );
}
