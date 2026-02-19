const ADAPTER_OPTIONS = [
  {
    name: "sdk-url",
    label: "Claude Code",
    description: "Claude CLI via WebSocket",
    color: "bg-bc-adapter-claude",
  },
  { name: "codex", label: "Codex", description: "OpenAI Codex CLI", color: "bg-bc-adapter-codex" },
  {
    name: "acp",
    label: "ACP",
    description: "Any ACP-compliant agent",
    color: "bg-bc-adapter-codex",
  },
] as const;

export function EmptyState({
  onAdapterSelect,
}: {
  onAdapterSelect?: (adapter: string) => void;
} = {}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="relative text-center">
        {/* Amber glow backdrop */}
        <div className="absolute left-1/2 top-1/2 -z-10 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bc-accent/[0.06] blur-3xl" />

        {/* Logo mark */}
        <div className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-bc-border bg-bc-surface">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <path
              d="M14 3L24 8.5v11L14 25 4 19.5v-11L14 3z"
              stroke="var(--color-bc-accent)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <circle cx="14" cy="14" r="3" fill="var(--color-bc-accent)" opacity="0.8" />
            <path
              d="M14 8v3M14 17v3M8.5 11l2.6 1.5M16.9 15.5l2.6 1.5M8.5 17l2.6-1.5M16.9 12.5l2.6-1.5"
              stroke="var(--color-bc-accent)"
              strokeWidth="1"
              opacity="0.4"
            />
          </svg>
        </div>

        <h2 className="mb-1.5 text-lg font-semibold tracking-tight text-bc-text">BeamCode</h2>

        {onAdapterSelect ? (
          <>
            <p className="mb-4 text-sm text-bc-text-muted">Choose an adapter to start a session</p>
            <div className="flex flex-col gap-2">
              {ADAPTER_OPTIONS.map((opt) => (
                <button
                  key={opt.name}
                  type="button"
                  onClick={() => onAdapterSelect(opt.name)}
                  className="flex items-center gap-3 rounded-lg border border-bc-border bg-bc-surface px-4 py-3 text-left transition-colors hover:border-bc-accent/40 hover:bg-bc-hover"
                >
                  <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${opt.color}`} />
                  <div>
                    <div className="text-sm font-medium text-bc-text">{opt.label}</div>
                    <div className="text-xs text-bc-text-muted">{opt.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-bc-text-muted">Send a message to start coding</p>
            <p className="mt-3 text-xs text-bc-text-muted/60">
              Type{" "}
              <kbd className="rounded border border-bc-border bg-bc-surface-2 px-1.5 py-0.5 font-mono-code text-[10px]">
                /
              </kbd>{" "}
              for commands
            </p>
          </>
        )}
      </div>
    </div>
  );
}
