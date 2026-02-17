import { useEffect, useRef } from "react";
import { useStore } from "../store";

const EMPTY_LOGS: string[] = [];

export function LogDrawer() {
  const logDrawerOpen = useStore((s) => s.logDrawerOpen);
  const setLogDrawerOpen = useStore((s) => s.setLogDrawerOpen);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const logs = useStore((s) =>
    s.currentSessionId ? (s.processLogs[s.currentSessionId] ?? EMPTY_LOGS) : EMPTY_LOGS,
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scroll on new log entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  // Close on Escape
  useEffect(() => {
    if (!logDrawerOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setLogDrawerOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [logDrawerOpen, setLogDrawerOpen]);

  if (!logDrawerOpen || !currentSessionId) return null;

  return (
    <div className="flex h-full w-[380px] flex-shrink-0 flex-col border-l border-bc-border bg-bc-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-bc-border px-4 py-2.5">
        <h3 className="text-xs font-semibold text-bc-text">Process Logs</h3>
        <button
          type="button"
          onClick={() => setLogDrawerOpen(false)}
          className="flex h-6 w-6 items-center justify-center rounded text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
          aria-label="Close logs"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-y-auto bg-bc-code-bg p-3">
        {logs.length === 0 ? (
          <div className="py-8 text-center text-xs text-bc-text-muted/50">No process logs yet</div>
        ) : (
          <pre className="font-mono-code text-[11px] leading-relaxed text-bc-text-muted whitespace-pre-wrap">
            {logs.join("\n")}
          </pre>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
