import { useStore } from "../store";

export function TopBar() {
  const sessionData = useStore((s) =>
    s.currentSessionId ? s.sessionData[s.currentSessionId] : null,
  );
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleTaskPanel = useStore((s) => s.toggleTaskPanel);

  const connectionStatus = sessionData?.connectionStatus ?? "disconnected";
  const model = sessionData?.state?.model ?? "";
  const pendingCount = sessionData ? Object.keys(sessionData.pendingPermissions).length : 0;

  let dotColor: string;
  switch (connectionStatus) {
    case "connected":
      dotColor = "bg-bc-success";
      break;
    case "connecting":
      dotColor = "bg-bc-warning animate-pulse";
      break;
    default:
      dotColor = "bg-bc-error";
  }

  return (
    <header className="flex items-center gap-2 border-b border-bc-border bg-bc-surface px-3 py-2">
      <button
        type="button"
        onClick={toggleSidebar}
        className="rounded p-1.5 text-bc-text-muted hover:bg-bc-hover md:hidden"
        aria-label="Toggle sidebar"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect y="2" width="16" height="1.5" rx="0.5" />
          <rect y="7" width="16" height="1.5" rx="0.5" />
          <rect y="12" width="16" height="1.5" rx="0.5" />
        </svg>
      </button>

      <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${dotColor}`} />
      <span className="text-xs text-bc-text-muted">{connectionStatus}</span>

      {model && (
        <span className="ml-2 rounded bg-bc-surface-2 px-2 py-0.5 text-xs text-bc-text-muted">
          {model}
        </span>
      )}

      <div className="flex-1" />

      {pendingCount > 0 && (
        <span className="rounded-full bg-bc-warning px-2 py-0.5 text-xs font-medium text-bc-bg">
          {pendingCount}
        </span>
      )}

      <button
        type="button"
        onClick={toggleTaskPanel}
        className="rounded p-1.5 text-bc-text-muted hover:bg-bc-hover"
        aria-label="Toggle task panel"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M2 4h12v1H2zM2 7.5h8v1H2zM2 11h10v1H2z" />
        </svg>
      </button>
    </header>
  );
}
