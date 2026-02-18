import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveSession,
  createSession,
  deleteSession,
  renameSession,
  unarchiveSession,
} from "../api";
import { type SdkSessionInfo, useStore } from "../store";
import { cwdBasename } from "../utils/format";
import { filterSessionsByQuery, sortedSessions, updateSessionUrl } from "../utils/session";
import { connectToSession, disconnectSession } from "../ws";

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
  exited: { dot: "bg-bc-text-muted/40", label: "Exited" },
};

const STATUS_DEFAULT = { dot: "border border-bc-text-muted/50", label: "Offline" };

function StatusDot({ status, exitCode }: { status: string | null; exitCode?: number | null }) {
  const { dot, label } = (status ? STATUS_STYLES[status] : null) ?? STATUS_DEFAULT;
  const tooltip = status === "exited" && exitCode != null ? `${label} (code ${exitCode})` : label;
  return (
    <span
      className={`h-2 w-2 flex-shrink-0 rounded-full ${dot}`}
      role="img"
      aria-label={tooltip}
      title={tooltip}
    />
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

/** Resolve the effective status: exited sessions should never appear "green". */
function resolveStatus(info: SdkSessionInfo, sessionStatus: string | null): string {
  if (info.state === "exited") return "exited";
  return sessionStatus ?? info.state;
}

/** Individual session row — subscribes only to its own status (primitive selector). */
const SessionItem = memo(function SessionItem({
  info,
  isActive,
  onSelect,
  onArchiveToggle,
}: {
  info: SdkSessionInfo;
  isActive: boolean;
  onSelect: () => void;
  onArchiveToggle: () => void;
}) {
  // Primitive return (string | null) — stable with Object.is, no derived objects.
  const sessionStatus = useStore((s) => s.sessionData[info.sessionId]?.sessionStatus ?? null);
  const updateSession = useStore((s) => s.updateSession);
  const status = resolveStatus(info, sessionStatus);
  const name = info.name ?? cwdBasename(info.cwd ?? "untitled");

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = useCallback(async () => {
    if (!editing) return;
    setEditing(false);
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === name) return;
    const prevName = useStore.getState().sessions[info.sessionId]?.name;
    updateSession(info.sessionId, { name: trimmed });
    try {
      await renameSession(info.sessionId, trimmed);
    } catch {
      updateSession(info.sessionId, { name: prevName });
    }
  }, [editing, editValue, name, info.sessionId, updateSession]);

  const cancelRename = useCallback(() => {
    setEditing(false);
    setEditValue(name);
  }, [name]);

  const startRename = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditValue(name);
      setEditing(true);
    },
    [name],
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await deleteSession(info.sessionId);
      } catch {
        // Session may already be gone on the server — remove locally regardless.
      }
      // Always tear down the deleted session's connection
      disconnectSession(info.sessionId);
      // Read fresh state at call-time to avoid stale closures.
      const { sessions, currentSessionId, removeSession, setCurrentSession } = useStore.getState();
      const wasActive = currentSessionId === info.sessionId;
      const next =
        Object.values(sessions)
          .filter((s) => s.sessionId !== info.sessionId)
          .sort((a, b) => b.createdAt - a.createdAt)[0]?.sessionId ?? null;
      removeSession(info.sessionId);
      if (wasActive) {
        if (next) {
          setCurrentSession(next);
          connectToSession(next);
        } else {
          useStore.setState({ currentSessionId: null });
        }
        updateSessionUrl(next);
      }
    },
    [info.sessionId],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: intentional — contains a nested delete <button>
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition-colors ${
        isActive
          ? "border-l-2 border-bc-accent bg-bc-active"
          : "border-l-2 border-transparent hover:bg-bc-hover"
      } ${info.archived ? "opacity-60" : ""}`}
      aria-current={isActive ? "page" : undefined}
    >
      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${adapterColor(info)}`} />
      <div className="min-w-0 flex-1">
        <div
          className={`flex items-center gap-1 truncate text-sm ${isActive ? "font-medium text-bc-text" : "text-bc-text-muted group-hover:text-bc-text"}`}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  inputRef.current?.blur();
                } else if (e.key === "Escape") {
                  cancelRename();
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 truncate rounded border border-bc-accent/50 bg-bc-bg px-1 text-sm outline-none"
              maxLength={100}
            />
          ) : (
            <span className="truncate">{name}</span>
          )}
          <span className="ml-auto flex flex-shrink-0 gap-0.5">
            <button
              type="button"
              onClick={startRename}
              className="rounded p-0.5 text-bc-text-muted/0 transition-colors hover:text-bc-text-muted group-hover:text-bc-text-muted/60"
              aria-label={`Rename session ${name}`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onArchiveToggle();
              }}
              className="rounded p-0.5 text-bc-text-muted/0 transition-colors hover:text-bc-text-muted group-hover:text-bc-text-muted/60"
              aria-label={`${info.archived ? "Unarchive" : "Archive"} session ${name}`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect
                  x="1"
                  y="2"
                  width="10"
                  height="2"
                  rx="0.5"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <path
                  d="M2 4v5.5a1 1 0 001 1h6a1 1 0 001-1V4"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <path d="M5 7h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded p-0.5 text-bc-text-muted/0 transition-colors hover:text-bc-error group-hover:text-bc-text-muted/60"
              aria-label={`Delete session ${name}`}
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
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-bc-text-muted/70">
          <StatusDot status={status} exitCode={info.exitCode} />
          <span>{formatTime(info.createdAt)}</span>
        </div>
      </div>
    </div>
  );
});

function SidebarFooterItem({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function SidebarFooter() {
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const soundEnabled = useStore((s) => s.soundEnabled);
  const toggleSound = useStore((s) => s.toggleSound);
  const alertsEnabled = useStore((s) => s.alertsEnabled);
  const toggleAlerts = useStore((s) => s.toggleAlerts);

  return (
    <div className="border-t border-bc-border">
      {/* Notification section */}
      <div className="px-3 pb-0.5 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-bc-text-muted/50">
          Notification
        </span>
      </div>

      <SidebarFooterItem
        icon={
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            {soundEnabled ? (
              <>
                <path
                  d="M2 5.5h2l3-2.5v8l-3-2.5H2a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5z"
                  fill="currentColor"
                />
                <path
                  d="M9.5 4.5c.8.8 1.2 1.6 1.2 2.5s-.4 1.7-1.2 2.5M8 5.5c.5.5.7 1 .7 1.5s-.2 1-.7 1.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </>
            ) : (
              <>
                <path
                  d="M2 5.5h2l3-2.5v8l-3-2.5H2a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5z"
                  fill="currentColor"
                  opacity="0.4"
                />
                <path
                  d="M9 5l3 4M12 5l-3 4"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </>
            )}
          </svg>
        }
        label={soundEnabled ? "Sound on" : "Sound off"}
        trailing={<TogglePill enabled={soundEnabled} />}
        onClick={toggleSound}
      />

      <SidebarFooterItem
        icon={
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 1.5c-2.5 0-4.5 1.5-4.5 3.5 0 1 .5 2 1.5 3 .5.5.5 1.5.5 2h5c0-.5 0-1.5.5-2 1-1 1.5-2 1.5-3 0-2-2-3.5-4.5-3.5z"
              fill="currentColor"
              opacity={alertsEnabled ? 1 : 0.4}
            />
            <path
              d="M5.5 10.5c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        }
        label={alertsEnabled ? "Alerts on" : "Alerts off"}
        trailing={<TogglePill enabled={alertsEnabled} />}
        onClick={toggleAlerts}
      />

      <div className="my-1 border-t border-bc-border/40" />

      <SidebarFooterItem
        icon={
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            {darkMode ? (
              <path
                d="M7 1C3.7 1 1 3.7 1 7s2.7 6 6 6c3.3 0 6-2.7 6-6 0-.3 0-.5-.1-.8C12 7.8 10.5 9 8.8 9 6.7 9 5 7.3 5 5.2c0-1.7 1.2-3.2 2.8-3.8-.3-.1-.5-.4-.8-.4z"
                fill="currentColor"
              />
            ) : (
              <>
                <circle cx="7" cy="7" r="2.5" fill="currentColor" />
                <path
                  d="M7 2v1M7 11v1M2 7h1M11 7h1M3.5 3.5l.7.7M9.8 9.8l.7.7M10.5 3.5l-.7.7M4.2 9.8l-.7.7"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                />
              </>
            )}
          </svg>
        }
        label={darkMode ? "Dark mode" : "Light mode"}
        onClick={toggleDarkMode}
      />

      <SidebarFooterItem
        icon={
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 9a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M11.4 8.6l.8.5a.5.5 0 01.1.6l-1 1.7a.5.5 0 01-.6.2l-.9-.4a4 4 0 01-.8.5l-.1 1a.5.5 0 01-.5.4H5.6a.5.5 0 01-.5-.4l-.1-1a4 4 0 01-.8-.5l-.9.4a.5.5 0 01-.6-.2l-1-1.7a.5.5 0 01.1-.6l.8-.5V7a4 4 0 010-.6l-.8-.5a.5.5 0 01-.1-.6l1-1.7a.5.5 0 01.6-.2l.9.4a4 4 0 01.8-.5l.1-1A.5.5 0 015.6 1h1.8a.5.5 0 01.5.4l.1 1a4 4 0 01.8.5l.9-.4a.5.5 0 01.6.2l1 1.7a.5.5 0 01-.1.6l-.8.5a4 4 0 010 1.2z"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        }
        label="Settings"
      />
    </div>
  );
}

function TogglePill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`flex h-4 w-7 flex-shrink-0 items-center rounded-full px-0.5 transition-colors ${
        enabled ? "bg-bc-success" : "bg-bc-surface-2"
      }`}
    >
      <span
        className={`h-3 w-3 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-3" : ""
        }`}
      />
    </span>
  );
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const updateSession = useStore((s) => s.updateSession);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const creatingRef = useRef(false);

  const handleNewSession = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const session = await createSession({});
      updateSession(session.sessionId, session);
      setCurrentSession(session.sessionId);
      connectToSession(session.sessionId);
      updateSessionUrl(session.sessionId, "push");
    } catch (err) {
      console.error("[sidebar] Failed to create session:", err);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [updateSession, setCurrentSession]);

  const sessionList = useMemo(() => sortedSessions(sessions), [sessions]);

  const filteredList = useMemo(
    () => filterSessionsByQuery(sessionList, search),
    [sessionList, search],
  );

  const { activeSessions, archivedSessions } = useMemo(() => {
    const active: SdkSessionInfo[] = [];
    const archived: SdkSessionInfo[] = [];
    for (const s of filteredList) {
      (s.archived ? archived : active).push(s);
    }
    return { activeSessions: active, archivedSessions: archived };
  }, [filteredList]);

  const handleArchiveToggle = useCallback(
    async (sessionId: string, currentlyArchived: boolean) => {
      try {
        if (currentlyArchived) {
          await unarchiveSession(sessionId);
        } else {
          await archiveSession(sessionId);
          // If archiving the active session, switch to next active one
          const { currentSessionId, setCurrentSession } = useStore.getState();
          if (currentSessionId === sessionId) {
            const next = activeSessions.find((s) => s.sessionId !== sessionId)?.sessionId ?? null;
            if (next) {
              setCurrentSession(next);
              connectToSession(next);
            } else {
              useStore.setState({ currentSessionId: null });
            }
            updateSessionUrl(next);
          }
          disconnectSession(sessionId);
        }
        updateSession(sessionId, { archived: !currentlyArchived });
      } catch (err) {
        console.error("[sidebar] Failed to toggle archive:", err);
      }
    },
    [activeSessions, updateSession],
  );

  // Group active sessions by project (cwd basename)
  const groupedSessions = useMemo(() => {
    const groups: Record<
      string,
      { project: string; sessions: SdkSessionInfo[]; runningCount: number }
    > = {};
    for (const s of activeSessions) {
      const project = cwdBasename(s.cwd ?? "untitled");
      if (!groups[project]) {
        groups[project] = { project, sessions: [], runningCount: 0 };
      }
      groups[project].sessions.push(s);
      if (s.state === "running" || s.state === "connected") {
        groups[project].runningCount++;
      }
    }
    return Object.values(groups);
  }, [activeSessions]);

  const showGroups = groupedSessions.length > 1;

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
          className="flex h-6 items-center rounded-md bg-bc-surface-2 px-2 text-[11px] text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text disabled:opacity-50"
          aria-label="New session"
          disabled={creating}
          onClick={handleNewSession}
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

      {/* Search filter */}
      {sessionList.length > 0 && (
        <div className="px-3 py-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions..."
            className="w-full rounded-md border border-bc-border bg-bc-bg px-2.5 py-1.5 text-xs text-bc-text placeholder:text-bc-text-muted/50 focus:border-bc-accent/50 focus:outline-none"
            aria-label="Search sessions"
          />
        </div>
      )}

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto py-1.5" aria-label="Sessions">
        {filteredList.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-bc-text-muted">
            {search ? "No matches" : "No sessions"}
          </div>
        ) : (
          <>
            {showGroups
              ? groupedSessions.map((group) => (
                  <details key={group.project} open>
                    <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-bc-text-muted/80 hover:text-bc-text-muted">
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        fill="currentColor"
                        className="flex-shrink-0 transition-transform [[open]>&]:rotate-90"
                        aria-hidden="true"
                      >
                        <path d="M2 1l4 3-4 3z" />
                      </svg>
                      <span className="truncate">{group.project}</span>
                      <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
                        {group.runningCount > 0 && (
                          <span className="text-[10px] text-bc-success">
                            {group.runningCount} running
                          </span>
                        )}
                        <span className="text-[10px] text-bc-text-muted/50">
                          {group.sessions.length}
                        </span>
                      </span>
                    </summary>
                    {group.sessions.map((info) => (
                      <SessionItem
                        key={info.sessionId}
                        info={info}
                        isActive={info.sessionId === currentSessionId}
                        onSelect={() => {
                          setCurrentSession(info.sessionId);
                          connectToSession(info.sessionId);
                        }}
                        onArchiveToggle={() => handleArchiveToggle(info.sessionId, !!info.archived)}
                      />
                    ))}
                  </details>
                ))
              : activeSessions.map((info) => (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    isActive={info.sessionId === currentSessionId}
                    onSelect={() => {
                      setCurrentSession(info.sessionId);
                      connectToSession(info.sessionId);
                    }}
                    onArchiveToggle={() => handleArchiveToggle(info.sessionId, !!info.archived)}
                  />
                ))}
            {archivedSessions.length > 0 && (
              <details className="mt-2 border-t border-bc-border/40 pt-1.5">
                <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
                  Archived ({archivedSessions.length})
                </summary>
                {archivedSessions.map((info) => (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    isActive={info.sessionId === currentSessionId}
                    onSelect={() => {
                      setCurrentSession(info.sessionId);
                      connectToSession(info.sessionId);
                    }}
                    onArchiveToggle={() => handleArchiveToggle(info.sessionId, !!info.archived)}
                  />
                ))}
              </details>
            )}
          </>
        )}
      </nav>

      {/* Footer section */}
      <SidebarFooter />
    </aside>
  );
}
