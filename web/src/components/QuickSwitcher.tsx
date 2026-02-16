import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SdkSessionInfo, useStore } from "../store";
import { cwdBasename } from "../utils/format";
import { connectToSession } from "../ws";

function updateSessionUrl(sessionId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  window.history.pushState({}, "", url);
}

interface QuickSwitcherProps {
  onClose: () => void;
}

export function QuickSwitcher({ onClose }: QuickSwitcherProps) {
  const sessions = useStore((s) => s.sessions);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessionList = useMemo(() => {
    const list = Object.values(sessions)
      .filter(
        (s): s is SdkSessionInfo =>
          s != null && typeof s.sessionId === "string" && typeof s.createdAt === "number",
      )
      .sort((a, b) => b.createdAt - a.createdAt);

    if (!query) return list;
    const q = query.toLowerCase();
    return list.filter((s) => {
      const name = s.name ?? cwdBasename(s.cwd ?? "");
      return name.toLowerCase().includes(q);
    });
  }, [sessions, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    setSelectedIndex(0);
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      setCurrentSession(sessionId);
      connectToSession(sessionId);
      updateSessionUrl(sessionId);
      onClose();
    },
    [setCurrentSession, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, sessionList.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (sessionList[selectedIndex]) {
            selectSession(sessionList[selectedIndex].sessionId);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [sessionList, selectedIndex, selectSession, onClose],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <button
        type="button"
        data-testid="quick-switcher-backdrop"
        className="absolute inset-0 cursor-default border-none bg-black/50"
        aria-label="Close quick switcher"
        onClick={onClose}
        tabIndex={-1}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-bc-border bg-bc-surface shadow-2xl">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Switch session..."
          className="w-full rounded-t-xl border-b border-bc-border bg-transparent px-4 py-3 text-sm text-bc-text placeholder:text-bc-text-muted/50 focus:outline-none"
        />
        <div className="max-h-[300px] overflow-y-auto py-1">
          {sessionList.length === 0 ? (
            <div className="px-4 py-3 text-center text-xs text-bc-text-muted">
              No sessions found
            </div>
          ) : (
            sessionList.map((s, i) => (
              <button
                key={s.sessionId}
                type="button"
                onClick={() => selectSession(s.sessionId)}
                className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors ${
                  i === selectedIndex
                    ? "bg-bc-active text-bc-text"
                    : "text-bc-text-muted hover:bg-bc-hover"
                }`}
              >
                <span className="truncate">{s.name ?? cwdBasename(s.cwd ?? "untitled")}</span>
                <span className="ml-auto text-[10px] text-bc-text-muted/50">
                  {cwdBasename(s.cwd ?? "")}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
