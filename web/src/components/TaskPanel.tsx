import { memo } from "react";
import { useShallow } from "zustand/shallow";
import type {
  ConsumerRole,
  ConsumerTeamMember,
  ConsumerTeamTask,
} from "../../../shared/consumer-types";
import { currentData, useStore } from "../store";
import { downloadFile, exportAsJson, exportAsMarkdown } from "../utils/export";
import { formatCost, formatTokens } from "../utils/format";
import { memberStatusDotClass, TASK_STATUS_ICONS } from "../utils/team-styles";
import { ContextGauge } from "./ContextGauge";

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

function computeCacheRatio(usage: ModelUsage): number {
  const totalInput =
    usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return totalInput > 0 ? Math.round((usage.cacheReadInputTokens / totalInput) * 100) : 0;
}

// ── Memoized sub-components ──────────────────────────────────────────────────

function ModelUsageCard({ model, usage }: { model: string; usage: ModelUsage }) {
  const cacheRatio = computeCacheRatio(usage);

  return (
    <div className="mb-2 rounded-lg border border-bc-border/40 bg-bc-surface-2/30 p-2.5 text-xs">
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
}

const TeamMemberItem = memo(function TeamMemberItem({ member }: { member: ConsumerTeamMember }) {
  const dotClass = memberStatusDotClass(member.status);
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <span className="truncate text-xs text-bc-text">{member.name}</span>
      <span className="ml-auto text-[10px] text-bc-text-muted">{member.agentType}</span>
    </div>
  );
});

const TeamTaskItem = memo(function TeamTaskItem({ task }: { task: ConsumerTeamTask }) {
  const icon = TASK_STATUS_ICONS[task.status] ?? "\u25CB";
  const isActive = task.status === "in_progress";
  return (
    <div className="py-1">
      <div className="flex items-start gap-1.5">
        <span
          className={`mt-0.5 text-xs ${isActive ? "text-bc-accent" : "text-bc-text-muted"}`}
          title={task.status}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-xs ${isActive ? "text-bc-text" : "text-bc-text-muted"}`}>
            {task.subject}
          </div>
          {task.owner && <div className="text-[10px] text-bc-text-muted/60">{task.owner}</div>}
          {isActive && task.activeForm && (
            <div className="text-[10px] italic text-bc-accent/70">{task.activeForm}</div>
          )}
        </div>
      </div>
    </div>
  );
});

const ROLE_BADGE_STYLES: Record<ConsumerRole, string> = {
  owner: "bg-bc-accent/20 text-bc-accent",
  operator: "bg-bc-accent/10 text-bc-accent/70",
  participant: "bg-bc-success/20 text-bc-success",
  observer: "bg-bc-text-muted/20 text-bc-text-muted",
};

function PresenceSection({
  consumers,
}: {
  consumers: Array<{ userId: string; displayName: string; role: ConsumerRole }>;
}) {
  if (consumers.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
        Connected Users ({consumers.length})
      </div>
      {consumers.map((c) => (
        <div key={c.userId} className="flex items-center gap-2 py-1">
          <span className="truncate text-xs text-bc-text">{c.displayName}</span>
          <span
            className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${ROLE_BADGE_STYLES[c.role] ?? ROLE_BADGE_STYLES.observer}`}
          >
            {c.role}
          </span>
        </div>
      ))}
    </div>
  );
}

const MCP_STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  connected: { dot: "bg-bc-success", label: "Connected" },
  failed: { dot: "bg-bc-error", label: "Failed" },
};
const MCP_STATUS_DEFAULT = { dot: "bg-bc-warning", label: "" };

function McpServersSection({ servers }: { servers: { name: string; status: string }[] }) {
  if (servers.length === 0) return null;
  return (
    <details className="mb-5" open>
      <summary className="mb-1.5 flex cursor-pointer items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
        MCP Servers ({servers.length})
      </summary>
      {servers.map((s) => {
        const style = MCP_STATUS_STYLES[s.status] ?? MCP_STATUS_DEFAULT;
        const label = style.label || s.status.charAt(0).toUpperCase() + s.status.slice(1);
        return (
          <div key={s.name} className="flex items-center gap-2 py-1">
            <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
            <span className="truncate text-xs text-bc-text">{s.name}</span>
            <span className="ml-auto text-[10px] text-bc-text-muted">{label}</span>
          </div>
        );
      })}
    </details>
  );
}

function HealthSection() {
  const connectionStatus = useStore((s) => currentData(s)?.connectionStatus ?? "disconnected");
  const cliConnected = useStore((s) => currentData(s)?.cliConnected ?? false);
  const reconnectAttempt = useStore((s) => currentData(s)?.reconnectAttempt ?? 0);
  const circuitBreaker = useStore((s) => currentData(s)?.state?.circuitBreaker ?? null);

  let statusDot: string;
  let statusLabel: string;
  if (connectionStatus === "connected" && cliConnected) {
    statusDot = "bg-bc-success";
    statusLabel = "Healthy";
  } else if (connectionStatus === "connected") {
    statusDot = "bg-bc-warning";
    statusLabel = "CLI disconnected";
  } else if (connectionStatus === "connecting") {
    statusDot = "bg-bc-warning animate-pulse";
    statusLabel = "Connecting...";
  } else {
    statusDot = "bg-bc-text-muted";
    statusLabel = "Disconnected";
  }

  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
        Connection Health
      </div>
      <div className="rounded-lg border border-bc-border/40 bg-bc-surface-2/30 p-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusDot}`} />
          <span className="text-bc-text">{statusLabel}</span>
        </div>
        {reconnectAttempt > 0 && (
          <div className="mt-1.5 text-bc-text-muted">
            Reconnect attempts: <span className="tabular-nums">{reconnectAttempt}</span>
          </div>
        )}
        {circuitBreaker && circuitBreaker.state !== "closed" && (
          <div className="mt-1.5 text-bc-warning">
            Circuit breaker: {circuitBreaker.state} ({circuitBreaker.failureCount} failures)
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function TaskPanel() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const state = useStore((s) =>
    s.currentSessionId ? s.sessionData[s.currentSessionId]?.state : null,
  );
  const presence = useStore(
    useShallow((s) => (s.currentSessionId ? s.sessionData[s.currentSessionId]?.presence : null)),
  );
  const messages = useStore(
    useShallow((s) => (s.currentSessionId ? s.sessionData[s.currentSessionId]?.messages : null)),
  );

  const hasSession = useStore((s) =>
    s.currentSessionId ? s.currentSessionId in s.sessionData : false,
  );

  if (!currentSessionId || !hasSession) return null;

  const team = state?.team ?? null;
  const cost = state?.total_cost_usd ?? 0;
  const turns = state?.num_turns ?? 0;
  const contextPercent = state?.context_used_percent ?? 0;
  const members = team?.members ?? [];
  const visibleTasks = (team?.tasks ?? []).filter((t) => t.status !== "deleted");
  const completedCount = visibleTasks.filter((t) => t.status === "completed").length;
  const progressPercent =
    visibleTasks.length > 0 ? Math.round((completedCount / visibleTasks.length) * 100) : 0;

  const handleExport = (format: "json" | "markdown") => {
    if (!messages) return;
    const isJson = format === "json";
    const content = isJson ? exportAsJson(messages) : exportAsMarkdown(messages);
    const ext = isJson ? "json" : "md";
    const mime = isJson ? "application/json" : "text/markdown";
    downloadFile(content, `beamcode-session-${currentSessionId}.${ext}`, mime);
    useStore.getState().addToast(`Exported as ${isJson ? "JSON" : "Markdown"}`, "success");
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

        {/* Connection health */}
        <HealthSection />

        {/* Lines changed */}
        {(state?.total_lines_added != null || state?.total_lines_removed != null) && (
          <div className="mb-5 grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-bc-surface-2/50 p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-bc-text-muted/60">
                Lines
              </div>
              <div className="mt-0.5 flex gap-2 font-mono-code text-sm tabular-nums">
                <span className="text-bc-success">+{state.total_lines_added ?? 0}</span>
                <span className="text-bc-error">-{state.total_lines_removed ?? 0}</span>
              </div>
            </div>
          </div>
        )}

        {/* Team Members */}
        {team && (
          <div className="mb-5">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
              Team Members
            </div>
            {members.length === 0 ? (
              <div className="text-xs text-bc-text-muted/50">No members</div>
            ) : (
              members.map((m) => <TeamMemberItem key={m.agentId} member={m} />)
            )}
          </div>
        )}

        {/* Team Tasks */}
        {team && visibleTasks.length > 0 && (
          <div className="mb-5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
                Team Tasks
              </span>
              <span className="text-[10px] tabular-nums text-bc-text-muted">
                {completedCount}/{visibleTasks.length}
              </span>
            </div>
            <div className="mb-2 h-1 overflow-hidden rounded-full bg-bc-surface-2">
              <div
                className="h-full rounded-full bg-bc-success transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {visibleTasks.map((t) => (
              <TeamTaskItem key={t.id} task={t} />
            ))}
          </div>
        )}

        {/* Connected users */}
        {presence && presence.length > 0 && <PresenceSection consumers={presence} />}

        {/* Model usage breakdown */}
        {state?.last_model_usage && (
          <div className="mb-5">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
              Model Usage
            </div>
            {Object.entries(state.last_model_usage).map(([model, usage]) => (
              <ModelUsageCard key={model} model={model} usage={usage} />
            ))}
          </div>
        )}

        {/* MCP servers */}
        {state?.mcp_servers && <McpServersSection servers={state.mcp_servers} />}

        {/* Export */}
        <div className="mt-5 border-t border-bc-border/40 pt-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
            Export
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleExport("markdown")}
              className="flex-1 rounded-lg border border-bc-border/60 px-3 py-1.5 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
            >
              Markdown
            </button>
            <button
              type="button"
              onClick={() => handleExport("json")}
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
