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

const STATUS_DOT_STYLES: Record<string, { className: string; label: string }> = {
  running: { className: "bg-bc-success animate-pulse", label: "Running" },
  compacting: { className: "border-2 border-bc-warning animate-spin", label: "Compacting" },
  idle: { className: "bg-bc-success", label: "Idle" },
};

const STATUS_DOT_DEFAULT = { className: "border-2 border-bc-text-muted", label: "Disconnected" };

function StatusDot({ status }: { status: string | null }) {
  const { className, label } = (status && STATUS_DOT_STYLES[status]) || STATUS_DOT_DEFAULT;
  return <span className={`h-2.5 w-2.5 rounded-full ${className}`} role="img" aria-label={label} />;
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  // Only subscribe to session statuses, not all sessionData (avoids re-render on streaming deltas)
  const sessionStatuses = useStore((s) => {
    const statuses: Record<string, string | null> = {};
    for (const id of Object.keys(s.sessions)) {
      statuses[id] = s.sessionData[id]?.sessionStatus ?? null;
    }
    return statuses;
  });
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);

  const sessionList = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-bc-border bg-bc-sidebar max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40">
      <div className="flex items-center justify-between border-b border-bc-border px-4 py-3">
        <span className="font-sans-ui text-sm font-semibold text-bc-accent">BeamCode</span>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-bc-text-muted hover:bg-bc-hover"
          aria-label="New session"
        >
          + New
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="Sessions">
        {sessionList.map((info) => {
          const status = sessionStatuses[info.sessionId];
          const isActive = info.sessionId === currentSessionId;
          const name = info.name ?? cwdBasename(info.cwd);

          return (
            <button
              type="button"
              key={info.sessionId}
              onClick={() => setCurrentSession(info.sessionId)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                isActive ? "bg-bc-active text-bc-text" : "text-bc-text-muted hover:bg-bc-hover"
              }`}
              aria-current={isActive ? "page" : undefined}
            >
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${adapterColor(info)}`} />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <StatusDot status={status} />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
