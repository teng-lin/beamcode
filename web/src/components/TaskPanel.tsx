import { useStore } from "../store";
import { formatCost } from "../utils/format";
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

  return (
    <aside className="flex h-full w-[280px] flex-col border-l border-bc-border bg-bc-sidebar">
      <div className="border-b border-bc-border px-4 py-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-bc-text-muted">
          Session Info
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Context gauge */}
        <div className="mb-4">
          <div className="mb-1 text-xs text-bc-text-muted">Context Window</div>
          <ContextGauge percent={contextPercent} />
        </div>

        {/* Stats */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-bc-text-muted">Cost</div>
            <div className="font-mono-code text-sm text-bc-text">{formatCost(cost)}</div>
          </div>
          <div>
            <div className="text-xs text-bc-text-muted">Turns</div>
            <div className="font-mono-code text-sm text-bc-text">{turns}</div>
          </div>
        </div>

        {/* Model usage breakdown */}
        {state?.last_model_usage && (
          <div>
            <div className="mb-2 text-xs text-bc-text-muted">Model Usage</div>
            {Object.entries(state.last_model_usage).map(([model, usage]) => (
              <div key={model} className="mb-2 rounded bg-bc-surface-2 p-2 text-xs">
                <div className="font-medium text-bc-text">{model}</div>
                <div className="mt-1 text-bc-text-muted">
                  {formatCost(usage.costUSD)} · {usage.inputTokens + usage.outputTokens} tokens
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
