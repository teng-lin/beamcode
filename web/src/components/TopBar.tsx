import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { currentData, useStore } from "../store";
import { send } from "../ws";

const CONNECTION_DOT_STYLES: Record<string, string> = {
  connected: "bg-bc-success",
  connecting: "bg-bc-warning animate-pulse",
};
const CONNECTION_DOT_DEFAULT = "bg-bc-text-muted";

export function TopBar() {
  const connectionStatus = useStore((s) => currentData(s)?.connectionStatus ?? "disconnected");
  const model = useStore((s) => currentData(s)?.state?.model ?? "");
  const pendingCount = useStore((s) => {
    const perms = currentData(s)?.pendingPermissions;
    return perms ? Object.keys(perms).length : 0;
  });
  const models = useStore((s) => currentData(s)?.capabilities?.models ?? null);
  const gitBranch = useStore((s) => currentData(s)?.state?.git_branch ?? null);
  const permissionMode = useStore((s) => currentData(s)?.state?.permissionMode ?? null);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const isObserver = identityRole !== null && identityRole !== "participant";
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleTaskPanel = useStore((s) => s.toggleTaskPanel);
  const { teamName, memberCount } = useStore(
    useShallow((s) => ({
      teamName: currentData(s)?.state?.team?.name ?? null,
      memberCount: currentData(s)?.state?.team?.members.length ?? 0,
    })),
  );

  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  // Close model dropdown when switching sessions
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentSessionId is an intentional trigger
  useEffect(() => {
    setModelMenuOpen(false);
  }, [currentSessionId]);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const handleSelectModel = useCallback(
    (value: string) => {
      send({ type: "set_model", model: value }, currentSessionId ?? undefined);
      setModelMenuOpen(false);
    },
    [currentSessionId],
  );

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
          className={`h-1.5 w-1.5 rounded-full ${CONNECTION_DOT_STYLES[connectionStatus] ?? CONNECTION_DOT_DEFAULT}`}
        />
        <span className="text-[11px] capitalize text-bc-text-muted">{connectionStatus}</span>
      </div>

      {/* Observer badge */}
      {isObserver && (
        <span className="rounded-md bg-bc-text-muted/10 px-2 py-0.5 text-[11px] text-bc-text-muted">
          Observer
        </span>
      )}

      {/* Model badge / picker */}
      {model && (
        <div className="relative" ref={modelMenuRef}>
          {models && models.length > 1 && !isObserver ? (
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
          {modelMenuOpen && models && models.length > 1 && !isObserver && (
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

      {/* Permission mode badge */}
      {permissionMode && permissionMode !== "default" && (
        <span
          className={`rounded-md px-2 py-0.5 text-[11px] ${
            permissionMode === "bypassPermissions"
              ? "bg-bc-success/15 text-bc-success"
              : permissionMode === "plan"
                ? "bg-blue-500/15 text-blue-400"
                : "bg-bc-surface-2 text-bc-text-muted"
          }`}
        >
          {permissionMode === "bypassPermissions"
            ? "Auto-Allow"
            : permissionMode === "plan"
              ? "Plan"
              : permissionMode}
        </span>
      )}

      {gitBranch && (
        <output
          className="flex items-center gap-1 rounded-md bg-bc-surface-2 px-2 py-0.5 font-mono-code text-[11px] text-bc-text-muted"
          aria-label="Git branch"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            aria-hidden="true"
          >
            <circle cx="5" cy="2" r="1.2" />
            <circle cx="5" cy="8" r="1.2" />
            <path d="M5 3.2V6.8" />
          </svg>
          {gitBranch}
        </output>
      )}

      {teamName && (
        <output
          className="flex items-center gap-1 rounded-md bg-bc-surface-2 px-2 py-0.5 text-[11px] text-bc-text-muted"
          aria-label="Team"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="3.5" r="1.5" />
            <circle cx="7" cy="3.5" r="1.5" />
            <path
              d="M0.5 8.5c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5M4.5 8.5c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5"
              opacity="0.7"
            />
          </svg>
          {teamName} ({memberCount})
        </output>
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
        className="relative flex h-7 w-7 items-center justify-center rounded text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
        aria-label="Toggle task panel"
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true">
          <path d="M2 3.5h11v1.2H2zM2 6.9h7.5v1.2H2zM2 10.3h9v1.2H2z" />
        </svg>
        {teamName && (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-bc-accent" />
        )}
      </button>
    </header>
  );
}
