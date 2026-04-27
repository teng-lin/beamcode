import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMessageFlow } from "../hooks/useMessageFlow";
import { useStore } from "../store";
import { ConnectorOverlay } from "./ConnectorOverlay";
import { MessagePill } from "./MessagePill";

export function MessageFlowPanel() {
  const messageFlowOpen = useStore((s) => s.messageFlowOpen);
  const setMessageFlowOpen = useStore((s) => s.setMessageFlowOpen);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const { messages, paused, pendingCount, setPaused, clear } = useMessageFlow(currentSessionId);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredTraceId, setHoveredTraceId] = useState<string | null>(null);
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(560);
  const [detailLevel, setDetailLevel] = useState<"compact" | "detailed">("compact");
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panelWidth;
      const onMove = (me: MouseEvent) => {
        const delta = startX - me.clientX; // drag left = grow
        setPanelWidth(Math.max(360, Math.min(1200, startWidth + delta)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [panelWidth],
  );

  // Escape to close
  useEffect(() => {
    if (!messageFlowOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMessageFlowOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [messageFlowOpen, setMessageFlowOpen]);

  // Auto-scroll
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scroll on new messages
  useEffect(() => {
    if (autoScroll && !paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, autoScroll, paused]);

  const allTypes = useMemo(() => {
    const types = new Set<string>();
    for (const m of messages) types.add(m.type);
    return [...types].sort();
  }, [messages]);

  const handleHoverStart = useCallback((msg: (typeof messages)[0]) => {
    setHoveredId(msg.id);
    if (msg.traceId) {
      setHoveredTraceId(msg.traceId);
    }
  }, []);

  const handleHoverEnd = useCallback(() => {
    setHoveredId(null);
    setHoveredTraceId(null);
  }, []);

  if (!messageFlowOpen || !currentSessionId) return null;

  const filtered =
    filterTypes.size > 0 ? messages.filter((m) => filterTypes.has(m.type)) : messages;

  const hoveredMsg = hoveredId ? messages.find((m) => m.id === hoveredId) : null;
  const pairedIdOfHovered = hoveredMsg?.pairedId ?? null;

  function toggleFilter(type: string) {
    setFilterTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <div
      className="relative flex h-full flex-shrink-0 flex-col border-l border-bc-border bg-[#0A0B0D]"
      style={{ width: panelWidth }}
    >
      {/* Resize handle on left edge */}
      {/* biome-ignore lint/a11y/useSemanticElements: resize handle requires div */}
      <div
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-bc-border/30 transition-colors hover:bg-bc-accent/60 active:bg-bc-accent focus:outline-none focus:bg-bc-accent/80"
        onMouseDown={handleResizeMouseDown}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPanelWidth((w) => Math.min(1200, w + 8));
          if (e.key === "ArrowRight") setPanelWidth((w) => Math.max(360, w - 8));
        }}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuenow={panelWidth}
        aria-valuemin={360}
        aria-valuemax={1200}
        aria-label="Resize message flow panel"
      />
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-bc-border px-3 py-2">
        <span className="font-mono-code text-[11px] font-bold tracking-wider text-[#22D3EE]">
          MESSAGE FLOW
        </span>

        {/* Live/Paused badge */}
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono-code text-[10px] transition-colors hover:bg-bc-hover"
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: paused ? "#F59E0B" : "#22C55E" }}
          />
          <span style={{ color: paused ? "#F59E0B" : "#22C55E" }}>
            {paused ? "PAUSED" : "LIVE"}
          </span>
          {paused && pendingCount > 0 && (
            <span className="text-bc-text-muted">+{pendingCount}</span>
          )}
        </button>

        <div className="ml-auto flex items-center gap-1">
          {/* Filter dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
              title="Filter by type"
            >
              types{filterTypes.size > 0 ? ` (${filterTypes.size})` : ""}
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 max-h-60 w-48 overflow-y-auto rounded border border-bc-border bg-bc-surface p-1 shadow-lg">
                {allTypes.map((type) => (
                  <label
                    key={type}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono-code text-[10px] text-bc-text-muted hover:bg-bc-hover"
                  >
                    <input
                      type="checkbox"
                      checked={filterTypes.has(type)}
                      onChange={() => toggleFilter(type)}
                      className="h-3 w-3"
                    />
                    {type}
                  </label>
                ))}
                {allTypes.length === 0 && (
                  <span className="block px-2 py-1 text-[10px] text-bc-text-muted/50">
                    No messages yet
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Detail level toggle */}
          <button
            type="button"
            onClick={() => setDetailLevel((d) => (d === "compact" ? "detailed" : "compact"))}
            className={`rounded px-1.5 py-0.5 font-mono-code text-[10px] transition-colors hover:bg-bc-hover ${detailLevel === "detailed" ? "text-[#8B5CF6]" : "text-bc-text-muted"}`}
            title={detailLevel === "compact" ? "Show boundaries" : "Hide boundaries"}
          >
            T1→T4
          </button>

          {/* Auto-scroll toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll((a) => !a)}
            className={`rounded px-1.5 py-0.5 font-mono-code text-[10px] transition-colors hover:bg-bc-hover ${autoScroll ? "text-[#22D3EE]" : "text-bc-text-muted"}`}
            title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
          >
            ↓
          </button>

          {/* Clear */}
          <button
            type="button"
            onClick={clear}
            className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
            title="Clear messages"
          >
            ⌫
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={() => setMessageFlowOpen(false)}
            className="flex h-6 w-6 items-center justify-center rounded text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
            aria-label="Close message flow"
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
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_40px_1fr] border-b border-bc-border/50 px-3 py-1">
        <span className="font-mono-code text-[9px] uppercase tracking-widest text-bc-text-muted/50">
          Outbound ↗
        </span>
        <span />
        <span className="text-right font-mono-code text-[9px] uppercase tracking-widest text-bc-text-muted/50">
          Inbound ↙
        </span>
      </div>

      {/* Scrollable body */}
      <div ref={containerRef} className="relative flex-1 overflow-y-auto px-2 py-1">
        <ConnectorOverlay hoveredId={hoveredId} messages={filtered} containerRef={containerRef} />

        {filtered.length === 0 ? (
          <div className="py-12 text-center font-mono-code text-[11px] text-bc-text-muted/30">
            Waiting for messages…
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((msg) => {
              const isDimmed =
                hoveredId !== null && msg.id !== hoveredId && msg.id !== pairedIdOfHovered;
              const isHighlighted = hoveredTraceId !== null && msg.traceId === hoveredTraceId;
              return (
                <div key={msg.id} className="grid grid-cols-[1fr_40px_1fr] items-start gap-1">
                  {msg.direction === "out" ? (
                    <>
                      <MessagePill
                        message={msg}
                        detailLevel={detailLevel}
                        dimmed={isDimmed}
                        highlighted={isHighlighted}
                        onHoverStart={() => handleHoverStart(msg)}
                        onHoverEnd={handleHoverEnd}
                      />
                      <span className="self-center text-center font-mono-code text-[8px] text-bc-text-muted/40">
                        +{msg.timestamp}
                      </span>
                      <div />
                    </>
                  ) : (
                    <>
                      <div />
                      <span className="self-center text-center font-mono-code text-[8px] text-bc-text-muted/40">
                        +{msg.timestamp}
                      </span>
                      <MessagePill
                        message={msg}
                        detailLevel={detailLevel}
                        dimmed={isDimmed}
                        highlighted={isHighlighted}
                        onHoverStart={() => handleHoverStart(msg)}
                        onHoverEnd={handleHoverEnd}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
