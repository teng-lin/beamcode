import { useCallback, useEffect, useState } from "react";
import { useDropdown } from "../hooks/useDropdown";
import { currentData, useStore } from "../store";
import { cwdBasename } from "../utils/format";
import { send } from "../ws";

const ADAPTER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  continue: "Continue",
  gemini: "Gemini",
};

const ADAPTER_COLORS: Record<string, string> = {
  claude: "bg-bc-adapter-claude text-bc-bg",
  codex: "bg-bc-adapter-codex text-bc-bg",
  continue: "bg-bc-adapter-continue text-white",
  gemini: "bg-bc-adapter-gemini text-white",
};

const ADAPTER_DOT_COLORS: Record<string, string> = {
  claude: "bg-bc-adapter-claude",
  codex: "bg-bc-adapter-codex",
  continue: "bg-bc-adapter-continue",
  gemini: "bg-bc-adapter-gemini",
};

function ChevronDown() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
      <path d="M2 3l2 2.5L6 3" />
    </svg>
  );
}

function AdapterSelector({ type }: { type: string }) {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const isObserver = identityRole === "observer";
  const { open, toggle, close, ref } = useDropdown();

  const handleSelect = useCallback(
    (adapter: string) => {
      if (currentSessionId) {
        useStore.getState().updateSession(currentSessionId, { adapterType: adapter });
      }
      send({ type: "set_adapter", adapter }, currentSessionId ?? undefined);
      close();
    },
    [currentSessionId, close],
  );

  const label = ADAPTER_LABELS[type] ?? type;
  const color = ADAPTER_COLORS[type] ?? "bg-bc-surface-2 text-bc-text-muted";
  const adapterKeys = Object.keys(ADAPTER_LABELS);

  if (isObserver || adapterKeys.length <= 1) {
    return (
      <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${color}`}>{label}</span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80 ${color}`}
      >
        {label}
        <ChevronDown />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[160px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
          {adapterKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => handleSelect(key)}
              className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-bc-hover ${
                key === type ? "font-semibold text-bc-text" : "text-bc-text-muted"
              }`}
            >
              {ADAPTER_LABELS[key]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Permission Mode Picker ───────────────────────────────────────────────────

const PERMISSION_MODES = [
  { value: "default", label: "Default", description: "Ask before risky actions" },
  { value: "plan", label: "Plan", description: "Require plan approval first" },
  {
    value: "bypassPermissions",
    label: "Auto-Approve",
    description: "Auto-approve all tool executions",
  },
];

const PERMISSION_STYLES: Record<string, string> = {
  default: "text-bc-text-muted",
  plan: "text-bc-accent",
  bypassPermissions: "text-bc-warning",
};

export function PermissionModePicker({ disabled }: { disabled?: boolean } = {}) {
  const permissionMode = useStore((s) => currentData(s)?.state?.permissionMode ?? null);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const isObserver = disabled ?? identityRole === "observer";
  const { open, toggle, close, ref } = useDropdown(currentSessionId);
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const [confirmingBypass, setConfirmingBypass] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setPendingMode(null);
    setConfirmingBypass(false);
  }, [currentSessionId]);

  // Clear pending state once the server confirms the mode change
  useEffect(() => {
    if (pendingMode && permissionMode === pendingMode) {
      setPendingMode(null);
    }
  }, [permissionMode, pendingMode]);

  const handleSelect = useCallback(
    (mode: string) => {
      if (mode === "bypassPermissions") {
        setConfirmingBypass(true);
        close();
        return;
      }
      setPendingMode(mode);
      send({ type: "set_permission_mode", mode }, currentSessionId ?? undefined);
      close();
    },
    [currentSessionId, close],
  );

  const confirmBypass = useCallback(() => {
    setPendingMode("bypassPermissions");
    send({ type: "set_permission_mode", mode: "bypassPermissions" }, currentSessionId ?? undefined);
    setConfirmingBypass(false);
  }, [currentSessionId]);

  if (!permissionMode || !currentSessionId) return null;

  const displayMode = pendingMode ?? permissionMode;
  const current = PERMISSION_MODES.find((m) => m.value === displayMode) ?? PERMISSION_MODES[0];
  const colorClass = PERMISSION_STYLES[displayMode] ?? "text-bc-text-muted";

  const isBypass = displayMode === "bypassPermissions";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !isObserver && toggle()}
        disabled={isObserver}
        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors ${colorClass}${
          isBypass ? " border border-bc-warning/40" : ""
        }${isObserver ? " cursor-default" : " cursor-pointer hover:bg-bc-hover"}`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M5 1L8.5 3v3c0 2-1.5 3-3.5 3S1.5 8 1.5 6V3L5 1z" opacity="0.7" />
        </svg>
        {current.label}
        {isBypass && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
            className="text-bc-warning"
          >
            <path d="M5 1L9 9H1L5 1z" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 4v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="5" cy="7.5" r="0.5" fill="currentColor" />
          </svg>
        )}
        {!isObserver && !isBypass && <ChevronDown />}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[200px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => handleSelect(m.value)}
              className={`flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-bc-hover ${
                m.value === displayMode ? "font-semibold text-bc-text" : "text-bc-text-muted"
              }`}
            >
              <span className="text-[12px]">{m.label}</span>
              <span className="text-[10px] text-bc-text-muted/60">{m.description}</span>
            </button>
          ))}
        </div>
      )}
      {confirmingBypass && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-md border border-bc-warning/40 bg-bc-surface p-3 shadow-lg">
          <div className="mb-2 text-xs font-medium text-bc-warning">Enable Auto-Approve?</div>
          <p className="mb-3 text-[11px] text-bc-text-muted">
            This will auto-approve all tool executions without confirmation, granting unrestricted
            access.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmingBypass(false)}
              className="rounded px-2.5 py-1 text-[11px] text-bc-text-muted transition-colors hover:bg-bc-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmBypass}
              className="rounded bg-bc-warning px-2.5 py-1 text-[11px] font-medium text-bc-bg transition-colors hover:bg-bc-warning/80"
            >
              Enable
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Model Picker ─────────────────────────────────────────────────────────────

/** Extract a display name with version ("Opus 4.6", "Sonnet 4.5") from the model identifier. */
export function abbreviateModelName(
  model: string,
  models: { value: string; displayName: string }[] | null,
): string {
  const displayName = models?.find((m) => m.value === model)?.displayName ?? model;
  const match = displayName.match(/(opus|sonnet|haiku)\s*([\d.]+)?/i);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    return match[2] ? `${family} ${match[2]}` : family;
  }
  return displayName;
}

export function ModelPicker({ disabled }: { disabled?: boolean } = {}) {
  const model = useStore((s) => currentData(s)?.state?.model ?? "");
  const models = useStore((s) => currentData(s)?.capabilities?.models ?? null);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const isObserver = disabled ?? identityRole === "observer";
  const { open, toggle, close, ref } = useDropdown(currentSessionId);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  // Reset pending state on session change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setPendingModel(null);
  }, [currentSessionId]);

  // Clear pending state once server confirms the model change
  useEffect(() => {
    if (pendingModel && model === pendingModel) {
      setPendingModel(null);
    }
  }, [model, pendingModel]);

  const canSwitch = models && models.length > 1 && !isObserver;
  const displayModel = pendingModel ?? model;

  const handleSelect = useCallback(
    (value: string) => {
      setPendingModel(value);
      send({ type: "set_model", model: value }, currentSessionId ?? undefined);
      close();
    },
    [currentSessionId, close],
  );

  if (!displayModel) return null;

  const shortName = abbreviateModelName(displayModel, models);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => canSwitch && toggle()}
        disabled={!canSwitch}
        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-bc-text-muted transition-colors ${
          canSwitch ? "cursor-pointer hover:bg-bc-hover hover:text-bc-text" : "cursor-default"
        }`}
      >
        {shortName}
        {canSwitch && <ChevronDown />}
      </button>
      {open && models && (
        <div className="absolute bottom-full right-0 z-50 mb-1 min-w-[180px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
          {models.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => handleSelect(m.value)}
              className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-bc-hover ${
                m.value === displayModel ? "font-semibold text-bc-text" : "text-bc-text-muted"
              }`}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Logs Button ──────────────────────────────────────────────────────────

function LogsButton() {
  const logDrawerOpen = useStore((s) => s.logDrawerOpen);
  const setLogDrawerOpen = useStore((s) => s.setLogDrawerOpen);
  const hasLogs = useStore((s) => {
    const id = s.currentSessionId;
    return id ? (s.processLogs[id]?.length ?? 0) > 0 : false;
  });

  if (!hasLogs) return null;

  return (
    <button
      type="button"
      onClick={() => setLogDrawerOpen(!logDrawerOpen)}
      className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors ${
        logDrawerOpen ? "text-bc-accent" : "text-bc-text-muted hover:bg-bc-hover hover:text-bc-text"
      }`}
      aria-label="Toggle process logs"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
        <rect x="1" y="1" width="8" height="1.5" rx="0.3" opacity="0.4" />
        <rect x="1" y="3.5" width="6" height="1.5" rx="0.3" opacity="0.6" />
        <rect x="1" y="6" width="7" height="1.5" rx="0.3" opacity="0.8" />
        <rect x="1" y="8.5" width="5" height="1.5" rx="0.3" />
      </svg>
      Logs
    </button>
  );
}

// ── Status Bar ───────────────────────────────────────────────────────────────

export function StatusBar() {
  const adapterType = useStore((s) =>
    s.currentSessionId ? (s.sessions[s.currentSessionId]?.adapterType ?? null) : null,
  );
  const cwd = useStore((s) => currentData(s)?.state?.cwd ?? null);
  const gitBranch = useStore((s) => currentData(s)?.state?.git_branch ?? null);
  const gitAhead = useStore((s) => currentData(s)?.state?.git_ahead ?? 0);
  const gitBehind = useStore((s) => currentData(s)?.state?.git_behind ?? 0);
  const isWorktree = useStore((s) => currentData(s)?.state?.is_worktree ?? false);

  return (
    <footer className="flex items-center gap-2 px-3 py-1">
      {/* Left: project + branch pill */}
      <div className="flex items-center gap-1.5 rounded-full border border-bc-border/50 px-2.5 py-0.5 text-[11px] text-bc-text-muted">
        <span
          className={`h-1.5 w-1.5 rounded-full ${(adapterType && ADAPTER_DOT_COLORS[adapterType]) ?? "bg-bc-text-muted/50"}`}
        />
        <span>{cwd ? cwdBasename(cwd) : "\u2014"}</span>
        {gitBranch && (
          <>
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
            <span className="font-mono-code">{gitBranch}</span>
            {(gitAhead > 0 || gitBehind > 0) && (
              <span className="flex items-center gap-0.5 text-[10px]">
                {gitAhead > 0 && (
                  <span className="text-bc-success">
                    {"\u2191"}
                    {gitAhead}
                  </span>
                )}
                {gitBehind > 0 && (
                  <span className="text-bc-warning">
                    {"\u2193"}
                    {gitBehind}
                  </span>
                )}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex-1" />

      {/* Right: worktree + logs + adapter type */}
      {isWorktree && (
        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-bc-accent/80">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            aria-hidden="true"
          >
            <rect x="1" y="1" width="8" height="8" rx="1.5" />
            <path d="M3 5l1.5 1.5L7 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Worktree
        </span>
      )}

      <LogsButton />

      {adapterType && <AdapterSelector type={adapterType} />}
    </footer>
  );
}
