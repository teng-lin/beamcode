import { useState } from "react";

interface ThinkingBlockProps {
  content: string;
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-bc-border/40 bg-bc-surface/50">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-bc-text-muted"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1" opacity="0.5" />
          <circle cx="4.5" cy="5" r="1" fill="currentColor" opacity="0.4" />
          <circle cx="7.5" cy="5" r="1" fill="currentColor" opacity="0.4" />
          <path
            d="M4.5 7.5Q6 8.5 7.5 7.5"
            stroke="currentColor"
            strokeWidth="0.8"
            fill="none"
            opacity="0.4"
          />
        </svg>
        <span className="italic opacity-70">Thinking...</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`ml-auto flex-shrink-0 opacity-50 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M3.5 2L7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && (
        <pre className="max-h-60 overflow-auto border-t border-bc-border/30 p-3 font-mono-code text-xs text-bc-text-muted/80 leading-relaxed">
          {content}
        </pre>
      )}
    </div>
  );
}
