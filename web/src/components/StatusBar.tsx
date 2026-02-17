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

function ModelPicker() {
  const model = useStore((s) => currentData(s)?.state?.model ?? "");
  const models = useStore((s) => currentData(s)?.capabilities?.models ?? null);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const identityRole = useStore((s) => currentData(s)?.identity?.role ?? null);
  const isObserver = identityRole !== null && identityRole !== "participant";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const canSwitch = models && models.length > 1 && !isObserver;

  // Close on session change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setOpen(false);
  }, [currentSessionId]);

  // Close on outside click / esc
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

  // Extract short display name (e.g. "claude-opus-4-6" → "Opus")
  const shortName = (() => {
    const m = models?.find((m) => m.value === model);
    if (m) {
      // Use displayName, try to shorten common patterns
      const dn = m.displayName;
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
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] rounded-md border border-bc-border bg-bc-surface py-1 shadow-lg">
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

export function StatusBar() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const adapterType = useStore((s) =>
    s.currentSessionId ? (s.sessions[s.currentSessionId]?.adapterType ?? null) : null,
  );
  const cwd = useStore((s) => currentData(s)?.state?.cwd ?? null);
  const gitBranch = useStore((s) => currentData(s)?.state?.git_branch ?? null);

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

      {/* Git branch */}
      <Divider />
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
      </span>

      <div className="flex-1" />

      {/* Model picker */}
      <ModelPicker />
    </footer>
  );
}

function Divider() {
  return <span className="mx-0.5 h-3 w-px bg-bc-border" />;
}
