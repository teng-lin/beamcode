import { useStore } from "../store";
import { downloadFile, exportAsJson, exportAsMarkdown } from "../utils/export";
import { formatCost, formatTokens } from "../utils/format";
import { ContextGauge } from "./ContextGauge";

export function TaskPanel() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessionData = useStore((s) =>
    s.currentSessionId ? s.sessionData[s.currentSessionId] : null,
  );

  if (!currentSessionId || !sessionData) return null;

  const state = sessionData.state;
  const cost = state?.total_cost_usd ?? 0;
  const turns = state?.num_turns ?? 0;
  const contextPercent = state?.context_used_percent ?? 0;

  const handleExportJson = () => {
    const content = exportAsJson(sessionData.messages);
    downloadFile(content, `beamcode-session-${currentSessionId}.json`, "application/json");
  };

  const handleExportMarkdown = () => {
    const content = exportAsMarkdown(sessionData.messages);
    downloadFile(content, `beamcode-session-${currentSessionId}.md`, "text/markdown");
  };

  return (
    <aside className="flex h-full w-[280px] flex-shrink-0 flex-col border-l border-bc-border bg-bc-sidebar max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40">
      <div className="flex items-center gap-2 border-b border-bc-border px-4 py-3">
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-bc-text-muted"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 4.5h6M4 7h4.5M4 9.5h5" stroke="currentColor" strokeWidth="1" opacity="0.6" />
        </svg>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-bc-text-muted">
          Session Info
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Context gauge */}
        <div className="mb-5">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
            Context Window
          </div>
          <ContextGauge percent={contextPercent} />
        </div>

        {/* Stats */}
        <div className="mb-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-bc-surface-2/50 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-bc-text-muted/60">Cost</div>
            <div className="mt-0.5 font-mono-code text-sm tabular-nums text-bc-text">
              {formatCost(cost)}
            </div>
          </div>
          <div className="rounded-lg bg-bc-surface-2/50 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-bc-text-muted/60">Turns</div>
            <div className="mt-0.5 font-mono-code text-sm tabular-nums text-bc-text">{turns}</div>
          </div>
        </div>

        {/* Model usage breakdown */}
        {state?.last_model_usage && (
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
              Model Usage
            </div>
            {Object.entries(state.last_model_usage).map(([model, usage]) => {
              const totalInput =
                usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
              const cacheRatio =
                totalInput > 0 ? Math.round((usage.cacheReadInputTokens / totalInput) * 100) : 0;

              return (
                <div
                  key={model}
                  className="mb-2 rounded-lg border border-bc-border/40 bg-bc-surface-2/30 p-2.5 text-xs"
                >
                  <div className="font-medium text-bc-text">{model}</div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums text-bc-text-muted">
                    <span>Input</span>
                    <span className="text-right">{formatTokens(usage.inputTokens)}</span>
                    <span>Output</span>
                    <span className="text-right">{formatTokens(usage.outputTokens)}</span>
                    {cacheRatio > 0 && (
                      <>
                        <span>Cache hit</span>
                        <span className="text-right">{cacheRatio}%</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1.5 border-t border-bc-border/30 pt-1.5 font-medium tabular-nums text-bc-text">
                    {formatCost(usage.costUSD)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Export */}
        <div className="mt-5 border-t border-bc-border/40 pt-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
            Export
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleExportMarkdown}
              className="flex-1 rounded-lg border border-bc-border/60 px-3 py-1.5 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
            >
              Markdown
            </button>
            <button
              type="button"
              onClick={handleExportJson}
              className="flex-1 rounded-lg border border-bc-border/60 px-3 py-1.5 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
            >
              JSON
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
