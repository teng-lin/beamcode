import { useState } from "react";
import type { ConsumerContentBlock } from "../../../shared/consumer-types";
import { MarkdownContent } from "./MarkdownContent";

interface ToolResultBlockProps {
  toolName: string | null;
  content: string | ConsumerContentBlock[];
  isError?: boolean;
}

const MAX_LINES = 50;

function contentToString(content: string | ConsumerContentBlock[]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

function truncateLines(text: string, max: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, truncated: false };
  return { text: lines.slice(0, max).join("\n"), truncated: true };
}

/** Monospace preformatted block with optional truncation. Used for Bash, Read, Write, Grep, Glob. */
function PreBlock({ text, isError }: { text: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { text: displayed, truncated } = expanded
    ? { text, truncated: false }
    : truncateLines(text, MAX_LINES);

  return (
    <div>
      <pre
        className={`max-h-80 overflow-auto bg-bc-code-bg p-3 font-mono-code text-xs leading-relaxed whitespace-pre-wrap ${
          isError ? "text-bc-error/80" : "text-bc-text-muted"
        }`}
      >
        {displayed}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-bc-border/30 px-3 py-1.5 text-center text-[11px] text-bc-text-muted/70 transition-colors hover:bg-bc-hover hover:text-bc-text"
        >
          Show all ({text.split("\n").length} lines)
        </button>
      )}
    </div>
  );
}

/** Formatted JSON with collapsible wrapper. Used for MCP tools and unknown tools. */
function JsonBlock({ content }: { content: string | ConsumerContentBlock[] }) {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  // Try to parse as JSON for pretty formatting
  let formatted = text;
  if (typeof content === "string") {
    try {
      formatted = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON — show raw
    }
  }
  return (
    <pre className="max-h-60 overflow-auto bg-bc-code-bg p-3 font-mono-code text-xs text-bc-text-muted leading-relaxed">
      {formatted}
    </pre>
  );
}

export function ToolResultBlock({ toolName, content, isError }: ToolResultBlockProps) {
  const label = toolName ?? "Tool result";
  const text = contentToString(content);

  return (
    <details className="rounded-lg border border-bc-border/40">
      <summary
        className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs transition-colors hover:bg-bc-hover ${
          isError ? "text-bc-error" : "text-bc-text-muted"
        }`}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className="flex-shrink-0 opacity-50"
          aria-hidden="true"
        >
          <path d="M3.5 2L7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span className="font-medium">{label}</span>
        {isError && <span className="text-bc-error/70">(error)</span>}
      </summary>
      <div className="border-t border-bc-border/30">
        {renderContent(toolName, text, content, isError)}
      </div>
    </details>
  );
}

/** Rendered markdown block for tools that return markdown-like content. */
function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="max-h-80 overflow-auto p-3 text-xs">
      <MarkdownContent content={text} />
    </div>
  );
}

function renderContent(
  toolName: string | null,
  text: string,
  content: string | ConsumerContentBlock[],
  isError?: boolean,
): React.ReactNode {
  switch (toolName) {
    case "Bash":
    case "Read":
    case "Write":
    case "Edit":
    case "Grep":
    case "Glob":
      return <PreBlock text={text} isError={isError} />;
    case "WebFetch":
    case "WebSearch":
      return <MarkdownBlock text={text} />;
    default:
      return <JsonBlock content={content} />;
  }
}
