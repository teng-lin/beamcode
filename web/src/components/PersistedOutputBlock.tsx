import { useState } from "react";
import type { ParsedPersistedOutput } from "../utils/persisted-output";
import { CopyButton } from "./CopyButton";

interface PersistedOutputBlockProps {
  parsed: ParsedPersistedOutput;
  isError?: boolean;
}

const MAX_PREVIEW_LINES = 30;

export function PersistedOutputBlock({ parsed, isError }: PersistedOutputBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = parsed.preview.split("\n");
  const truncated = lines.length > MAX_PREVIEW_LINES;
  const displayed = expanded ? parsed.preview : lines.slice(0, MAX_PREVIEW_LINES).join("\n");

  return (
    <div>
      {/* Header banner */}
      <div className="flex items-center gap-2 bg-bc-surface-2/50 px-3 py-2 text-xs text-bc-text-muted">
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <path
            d="M2 1.5h5l3 3v6a1 1 0 01-1 1H2a1 1 0 01-1-1v-8a1 1 0 011-1z"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.6"
          />
          <path d="M7 1.5v3h3" stroke="currentColor" strokeWidth="1" opacity="0.4" />
        </svg>
        <span>
          Output truncated ({parsed.size}) — saved to{" "}
          <code className="rounded bg-bc-code-bg px-1 py-0.5 font-mono-code text-[11px]">
            {parsed.filePath}
          </code>
        </span>
      </div>

      {/* Preview content */}
      <div className="group/pre relative">
        <CopyButton text={parsed.preview} />
        <pre
          className={`max-h-80 overflow-auto bg-bc-code-bg p-3 font-mono-code text-xs leading-relaxed whitespace-pre-wrap ${
            isError ? "text-bc-error/80" : "text-bc-text-muted"
          }`}
        >
          {displayed}
        </pre>
        {truncated && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full border-t border-bc-border/30 px-3 py-1.5 text-center text-[11px] text-bc-text-muted/70 transition-colors hover:bg-bc-hover hover:text-bc-text"
          >
            Show full preview ({lines.length} lines)
          </button>
        )}
      </div>
    </div>
  );
}
