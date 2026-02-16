import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { send } from "../ws";

export function TopBar() {
  const connectionStatus = useStore(
    (s) =>
      (s.currentSessionId ? s.sessionData[s.currentSessionId]?.connectionStatus : null) ??
      "disconnected",
  );
  const model = useStore(
    (s) => (s.currentSessionId ? s.sessionData[s.currentSessionId]?.state?.model : null) ?? "",
  );
  const pendingCount = useStore((s) => {
    if (!s.currentSessionId) return 0;
    const perms = s.sessionData[s.currentSessionId]?.pendingPermissions;
    return perms ? Object.keys(perms).length : 0;
  });
  const models = useStore((s) =>
    s.currentSessionId ? (s.sessionData[s.currentSessionId]?.capabilities?.models ?? null) : null,
  );
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleTaskPanel = useStore((s) => s.toggleTaskPanel);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const handleSelectModel = useCallback((value: string) => {
    send({ type: "set_model", model: value });
    setModelMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!modelMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modelMenuOpen]);

  return (
    <header className="flex h-11 items-center gap-3 border-b border-bc-border bg-bc-surface px-3">
      {/* Sidebar toggle */}
      <button
        type="button"
        onClick={toggleSidebar}
        className="flex h-7 w-7 items-center justify-center rounded text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
      >
        {sidebarOpen ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="1" y="1" width="13" height="13" rx="2" />
            <line x1="5.5" y1="1" x2="5.5" y2="14" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true">
            <rect y="2.5" width="15" height="1.5" rx="0.5" />
            <rect y="6.75" width="15" height="1.5" rx="0.5" />
            <rect y="11" width="15" height="1.5" rx="0.5" />
          </svg>
        )}
      </button>

      {/* Connection status */}
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            connectionStatus === "connected"
              ? "bg-bc-success"
              : connectionStatus === "connecting"
                ? "bg-bc-warning animate-pulse"
                : "bg-bc-text-muted"
          }`}
        />
        <span className="text-[11px] capitalize text-bc-text-muted">{connectionStatus}</span>
      </div>

      {/* Model badge / picker */}
      {model && (
        <div className="relative" ref={modelMenuRef}>
          {models && models.length > 1 ? (
            <button
              type="button"
              onClick={() => setModelMenuOpen((o) => !o)}
              className="rounded-md bg-bc-surface-2 px-2 py-0.5 font-mono-code text-[11px] text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
              aria-label="Change model"
            >
              {model}
            </button>
          ) : (
            <span className="rounded-md bg-bc-surface-2 px-2 py-0.5 font-mono-code text-[11px] text-bc-text-muted">
              {model}
            </span>
          )}
          {modelMenuOpen && models && models.length > 1 && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
              {models.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => handleSelectModel(m.value)}
                  className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-bc-hover ${
                    m.value === model ? "font-semibold text-bc-text" : "text-bc-text-muted"
                  }`}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* Pending permissions badge */}
      {pendingCount > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-bc-warning px-1.5 text-[10px] font-bold text-bc-bg">
          {pendingCount}
        </span>
      )}

      {/* Task panel toggle */}
      <button
        type="button"
        onClick={toggleTaskPanel}
        className="flex h-7 w-7 items-center justify-center rounded text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
        aria-label="Toggle task panel"
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true">
          <path d="M2 3.5h11v1.2H2zM2 6.9h7.5v1.2H2zM2 10.3h9v1.2H2z" />
        </svg>
      </button>
    </header>
  );
}
