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
    <div className="rounded border border-bc-border bg-bc-surface">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
      >
        <span className="font-medium text-bc-accent">{blocks[0].name}</span>
        <span className="rounded bg-bc-surface-2 px-1.5 py-0.5 text-bc-text-muted">
          {blocks.length}
        </span>
        <span className="ml-auto text-bc-text-muted">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1 border-t border-bc-border p-2">
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
