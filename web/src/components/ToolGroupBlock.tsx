import { useState } from "react";
import { ToolBlock } from "./ToolBlock";

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolGroupBlockProps {
  blocks: ToolUseBlock[];
  sessionId: string;
}

export function ToolGroupBlock({ blocks, sessionId }: ToolGroupBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (blocks.length === 0) return null;

  return (
    <div className="rounded-lg border border-bc-border/60 bg-bc-surface transition-colors hover:border-bc-border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <rect
            x="1"
            y="1"
            width="10"
            height="10"
            rx="2"
            stroke="var(--color-bc-accent)"
            strokeWidth="1.2"
            opacity="0.7"
          />
          <path
            d="M4 4h4M4 6h4M4 8h4"
            stroke="var(--color-bc-accent)"
            strokeWidth="0.8"
            opacity="0.5"
          />
        </svg>
        <span className="font-medium text-bc-accent">{blocks[0].name}</span>
        <span className="rounded-full bg-bc-accent/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-bc-accent">
          {blocks.length}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          className={`ml-auto flex-shrink-0 text-bc-text-muted/50 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M3.5 2L7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 border-t border-bc-border/50 p-2">
          {blocks.map((block) => (
            <ToolBlock
              key={block.id}
              id={block.id}
              name={block.name}
              input={block.input}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
