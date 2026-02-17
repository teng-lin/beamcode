import { useCallback, useEffect, useRef, useState } from "react";
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

function AdapterBadge({ type }: { type: string }) {
  const label = ADAPTER_LABELS[type] ?? type;
  const color = ADAPTER_COLORS[type] ?? "bg-bc-surface-2 text-bc-text-muted";
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${color}`}>{label}</span>;
}

// ── Permission Mode Picker ───────────────────────────────────────────────────

const PERMISSION_MODES = [
  { value: "default", label: "Default", description: "Ask before risky actions" },
  { value: "plan", label: "Plan", description: "Require plan approval first" },
  { value: "bypassPermissions", label: "YOLO", description: "Auto-allow everything" },
];

const PERMISSION_STYLES: Record<string, string> = {
  default: "text-bc-text-muted",
  plan: "text-bc-accent",
  bypassPermissions: "text-bc-success",
};

function PermissionModePicker() {
  const permissionMode = useStore((s) => currentData(s)?.state?.permissionMode ?? null);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const isObserver = identityRole !== null && identityRole !== "participant";
  const [open, setOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setOpen(false);
    setPendingMode(null);
  }, [currentSessionId]);

  // Clear pending state once the server confirms the mode change
  useEffect(() => {
    if (pendingMode && permissionMode === pendingMode) {
      setPendingMode(null);
    }
  }, [permissionMode, pendingMode]);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSelect = useCallback(
    (mode: string) => {
      setPendingMode(mode);
      send({ type: "set_permission_mode", mode }, currentSessionId ?? undefined);
      setOpen(false);
    },
    [currentSessionId],
  );

  if (!permissionMode || !currentSessionId) return null;

  const displayMode = pendingMode ?? permissionMode;
  const current = PERMISSION_MODES.find((m) => m.value === displayMode) ?? PERMISSION_MODES[0];
  const colorClass = PERMISSION_STYLES[displayMode] ?? "text-bc-text-muted";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !isObserver && setOpen((o) => !o)}
        disabled={isObserver}
        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors ${colorClass} ${
          !isObserver ? "cursor-pointer hover:bg-bc-hover" : "cursor-default"
        }`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M5 1L8.5 3v3c0 2-1.5 3-3.5 3S1.5 8 1.5 6V3L5 1z" opacity="0.7" />
        </svg>
        {current.label}
        {!isObserver && (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
            <path d="M2 3l2 2.5L6 3" />
          </svg>
        )}
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 min-w-[200px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
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
    </div>
  );
}

// ── Model Picker ─────────────────────────────────────────────────────────────

function ModelPicker() {
  const model = useStore((s) => currentData(s)?.state?.model ?? "");
  const models = useStore((s) => currentData(s)?.capabilities?.models ?? null);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const isObserver = identityRole !== null && identityRole !== "participant";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const canSwitch = models && models.length > 1 && !isObserver;

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setOpen(false);
  }, [currentSessionId]);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSelect = useCallback(
    (value: string) => {
      send({ type: "set_model", model: value }, currentSessionId ?? undefined);
      setOpen(false);
    },
    [currentSessionId],
  );

  if (!model) return null;

  const shortName = (() => {
    const found = models?.find((m) => m.value === model);
    if (found) {
      const dn = found.displayName;
      if (/opus/i.test(dn)) return "Opus";
      if (/sonnet/i.test(dn)) return "Sonnet";
      if (/haiku/i.test(dn)) return "Haiku";
      return dn;
    }
    if (/opus/i.test(model)) return "Opus";
    if (/sonnet/i.test(model)) return "Sonnet";
    if (/haiku/i.test(model)) return "Haiku";
    return model;
  })();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => canSwitch && setOpen((o) => !o)}
        disabled={!canSwitch}
        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-bc-text-muted transition-colors ${
          canSwitch ? "hover:bg-bc-hover hover:text-bc-text cursor-pointer" : "cursor-default"
        }`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M5 0L8 4H6v3H4V4H2L5 0zM2 8h6v1H2V8z" opacity="0.7" />
        </svg>
        {shortName}
        {canSwitch && (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
            <path d="M2 3l2 2.5L6 3" />
          </svg>
        )}
      </button>
      {open && models && (
        <div className="absolute bottom-full right-0 z-50 mb-1 min-w-[180px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
          {models.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => handleSelect(m.value)}
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
    <footer className="flex items-center gap-1 border-t border-bc-border/40 bg-bc-surface px-3 py-1">
      {/* Adapter type */}
      {adapterType ? (
        <AdapterBadge type={adapterType} />
      ) : (
        <span className="rounded-md bg-bc-surface-2 px-2 py-0.5 text-[11px] text-bc-text-muted/50">
          No session
        </span>
      )}

      <Divider />

      {/* Folder / cwd */}
      <span className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-bc-text-muted">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M1 2h3l1 1h4v5.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5V2.5A.5.5 0 011 2z" />
        </svg>
        {cwd ? cwdBasename(cwd) : "\u2014"}
      </span>

      <Divider />

      {/* Git branch + ahead/behind */}
      <span className="flex items-center gap-1 rounded-md px-2 py-0.5 font-mono-code text-[11px] text-bc-text-muted">
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
        {gitBranch ?? "\u2014"}
        {(gitAhead > 0 || gitBehind > 0) && (
          <span className="ml-0.5 flex items-center gap-0.5 text-[10px]">
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
      </span>

      {/* Worktree badge */}
      {isWorktree && (
        <>
          <Divider />
          <span className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-bc-accent/80">
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              aria-hidden="true"
            >
              <path d="M5 1v4M5 5L2.5 8M5 5L7.5 8" strokeLinecap="round" />
            </svg>
            Worktree
          </span>
        </>
      )}

      <div className="flex-1" />

      {/* Permission mode picker */}
      <PermissionModePicker />

      <Divider />

      {/* Model picker */}
      <ModelPicker />
    </footer>
  );
}

function Divider() {
  return <span className="mx-0.5 h-3 w-px bg-bc-border" />;
}
