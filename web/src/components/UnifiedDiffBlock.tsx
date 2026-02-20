import { useMemo, useState } from "react";
import { truncateLines } from "../utils/truncate";
import type { UnifiedDiffLine, UnifiedDiffSegment } from "../utils/unified-diff";
import { parseUnifiedDiff } from "../utils/unified-diff";
import { CopyButton } from "./CopyButton";

const MAX_LINES = 50;

interface UnifiedDiffBlockProps {
  text: string;
  isError?: boolean;
}

function lineStyle(type: UnifiedDiffLine["type"]): string {
  switch (type) {
    case "added":
      return "bg-bc-success/10 text-bc-success";
    case "removed":
      return "bg-bc-error/10 text-bc-error";
    case "hunk-header":
      return "text-bc-accent/70";
    case "header":
    case "file-header":
      return "text-bc-text-muted/50";
    default:
      return "text-bc-text-muted";
  }
}

function isNoNewline(line: UnifiedDiffLine): boolean {
  return line.type === "header" && line.text.startsWith("\\ ");
}

function DiffSegment({ segment }: { segment: Extract<UnifiedDiffSegment, { kind: "diff" }> }) {
  return (
    <div>
      {segment.filePath && (
        <div className="border-b border-bc-border/40 px-3 py-1.5 font-mono-code text-[11px] text-bc-text-muted">
          {segment.filePath}
        </div>
      )}
      {segment.lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reorders
          key={i}
          className={`px-3 ${lineStyle(line.type)} ${isNoNewline(line) ? "italic" : ""}`}
          data-diff={line.type}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

export function UnifiedDiffBlock({ text, isError }: UnifiedDiffBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const {
    text: displayedText,
    truncated,
    totalLines,
  } = expanded ? { text, truncated: false, totalLines: 0 } : truncateLines(text, MAX_LINES);

  const displayedSegments = useMemo(() => parseUnifiedDiff(displayedText), [displayedText]);

  return (
    <div className="group/pre relative">
      <CopyButton text={text} />
      <pre className="max-h-80 overflow-auto bg-bc-code-bg font-mono-code text-xs leading-relaxed whitespace-pre-wrap">
        {displayedSegments.map((segment, i) =>
          segment.kind === "text" ? (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static content
              key={i}
              className={`px-3 py-0.5 ${isError ? "text-bc-error/80" : "text-bc-text-muted"}`}
            >
              {segment.content}
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content
            <DiffSegment key={i} segment={segment} />
          ),
        )}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-bc-border/30 px-3 py-1.5 text-center text-[11px] text-bc-text-muted/70 transition-colors hover:bg-bc-hover hover:text-bc-text"
        >
          Show all ({totalLines} lines)
        </button>
      )}
    </div>
  );
}
