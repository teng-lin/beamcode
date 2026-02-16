import { useState } from "react";

interface ThinkingBlockProps {
  content: string;
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded border border-bc-border/50 bg-bc-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-bc-text-muted"
      >
        <span className="italic">Thinking...</span>
        <span className="ml-auto">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="max-h-60 overflow-auto border-t border-bc-border/50 p-2 font-mono-code text-xs text-bc-text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}
