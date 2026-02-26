import type { RefObject } from "react";
import type { FlowMessage } from "./MessagePill";
import { getColor } from "./MessagePill";

interface ConnectorOverlayProps {
  hoveredId: string | null;
  messages: FlowMessage[];
  containerRef: RefObject<HTMLDivElement | null>;
}

const svgStyle = {
  position: "absolute" as const,
  inset: 0,
  pointerEvents: "none" as const,
  overflow: "visible" as const,
  width: "100%",
  height: "100%",
};

export function ConnectorOverlay({ hoveredId, messages, containerRef }: ConnectorOverlayProps) {
  if (!hoveredId || !containerRef.current) {
    return <svg style={svgStyle} />;
  }

  const hovered = messages.find((m) => m.id === hoveredId);
  if (!hovered?.pairedId) {
    return <svg style={svgStyle} />;
  }

  const paired = messages.find((m) => m.id === hovered.pairedId);
  if (!paired) {
    return <svg style={svgStyle} />;
  }

  const container = containerRef.current;
  const el1 = container.querySelector(`[data-flow-id="${hoveredId}"]`);
  const el2 = container.querySelector(`[data-flow-id="${hovered.pairedId}"]`);
  if (!el1 || !el2) {
    return <svg style={svgStyle} />;
  }

  const containerRect = container.getBoundingClientRect();
  const rect1 = el1.getBoundingClientRect();
  const rect2 = el2.getBoundingClientRect();

  const x1 = rect1.left - containerRect.left + rect1.width / 2;
  const y1 = rect1.top - containerRect.top + rect1.height / 2;
  const x2 = rect2.left - containerRect.left + rect2.width / 2;
  const y2 = rect2.top - containerRect.top + rect2.height / 2;
  const midX = containerRect.width / 2;

  const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
  const color = getColor(hovered.type);
  const latencyMs = Math.abs(hovered.wallTime - paired.wallTime);

  return (
    <svg style={svgStyle} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={0.8}
        strokeDasharray="200"
        strokeDashoffset="0"
        style={{ transition: "stroke-dashoffset 0.2s ease-out" }}
      />
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 8}
        textAnchor="middle"
        fontSize="10"
        fill={color}
        fillOpacity={0.9}
        fontFamily="monospace"
      >
        +{latencyMs}ms
      </text>
    </svg>
  );
}
