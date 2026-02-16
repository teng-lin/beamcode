import { useStore } from "../store";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const MOD = isMac ? "\u2318" : "Ctrl";

const SHORTCUTS = [
  { keys: `${MOD}+B`, label: "Toggle sidebar" },
  { keys: `${MOD}+.`, label: "Toggle task panel" },
  { keys: "?", label: "Show shortcuts" },
  { keys: "Esc", label: "Close modal / interrupt" },
] as const;

export function ShortcutsModal() {
  const open = useStore((s) => s.shortcutsModalOpen);
  const close = useStore((s) => s.setShortcutsModalOpen);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        data-testid="shortcuts-backdrop"
        className="absolute inset-0 cursor-default border-none bg-black/50"
        onClick={() => close(false)}
        aria-label="Close shortcuts modal"
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-bc-border bg-bc-surface p-5 shadow-2xl">
        <h2 className="mb-4 text-sm font-semibold text-bc-text">Keyboard Shortcuts</h2>
        <div className="space-y-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between text-xs">
              <span className="text-bc-text-muted">{s.label}</span>
              <kbd className="rounded bg-bc-surface-2 px-2 py-0.5 font-mono-code text-[11px] text-bc-text">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
