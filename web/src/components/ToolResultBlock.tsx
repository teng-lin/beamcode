import { useState } from "react";
import type { ConsumerContentBlock } from "../../../shared/consumer-types";
import { stripAnsi } from "../utils/ansi-strip";
import { truncateLines } from "../utils/truncate";
import { containsUnifiedDiff } from "../utils/unified-diff";
import { CopyButton } from "./CopyButton";
import { MarkdownContent } from "./MarkdownContent";
import { UnifiedDiffBlock } from "./UnifiedDiffBlock";

interface ToolResultBlockProps {
  toolName: string | null;
  content: string | ConsumerContentBlock[];
  isError?: boolean;
}

export const MAX_LINES = 50;

function contentToString(content: string | ConsumerContentBlock[]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

/** Render line content with optional line numbers and custom processing. */
function renderLines(
  lines: string[],
  gutterWidth: number,
  showLineNumbers?: boolean,
  processLine?: (line: string, index: number) => React.ReactNode,
): React.ReactNode {
  if (showLineNumbers) {
    return lines.map((line, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static line content, never reorders
      <div key={i} className="flex">
        <span
          className="mr-3 inline-block select-none text-right text-bc-text-muted/30"
          style={{ minWidth: `${gutterWidth}ch` }}
        >
          {i + 1}
        </span>
        <span className="flex-1">{processLine ? processLine(line, i) : line}</span>
      </div>
    ));
  }

  if (processLine) {
    return lines.map((line, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static line content, never reorders
      <div key={i}>{processLine(line, i)}</div>
    ));
  }

  return null;
}

/** Monospace preformatted block with line numbers, copy button, and optional truncation. */
function PreBlock({
  text,
  isError,
  showLineNumbers,
  processLine,
}: {
  text: string;
  isError?: boolean;
  showLineNumbers?: boolean;
  processLine?: (line: string, index: number) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const {
    text: displayed,
    truncated,
    totalLines,
  } = expanded ? { text, truncated: false, totalLines: 0 } : truncateLines(text, MAX_LINES);

  const lines = displayed.split("\n");
  const gutterWidth = String(totalLines || lines.length).length;
  const renderedLines = renderLines(lines, gutterWidth, showLineNumbers, processLine);

  return (
    <div className="group/pre relative">
      <CopyButton text={text} />
      <pre
        className={`max-h-80 overflow-auto bg-bc-code-bg p-3 font-mono-code text-xs leading-relaxed whitespace-pre-wrap ${
          isError ? "text-bc-error/80" : "text-bc-text-muted"
        }`}
      >
        {renderedLines ?? displayed}
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

/** Try to pretty-print a string as JSON; return the original if it is not valid JSON. */
function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Formatted JSON with collapsible wrapper. Used for MCP tools and unknown tools. */
function JsonBlock({ content }: { content: string | ConsumerContentBlock[] }) {
  const raw = contentToString(content);
  const formatted = typeof content === "string" ? tryFormatJson(raw) : raw;
  return (
    <div className="group/pre relative">
      <CopyButton text={formatted} />
      <pre className="max-h-60 overflow-auto bg-bc-code-bg p-3 font-mono-code text-xs text-bc-text-muted leading-relaxed">
        {formatted}
      </pre>
    </div>
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

/** Highlight grep match segments in a line (file:line:match pattern). */
function highlightGrepLine(line: string): React.ReactNode {
  // Grep results often look like: "path/file.ts:42:  matched text here"
  const match = line.match(/^([^:]+:\d+:)(.*)/);
  if (!match) return line;
  const [, prefix, rest] = match;
  return (
    <>
      <span className="text-bc-text-muted/50">{prefix}</span>
      <span>{rest}</span>
    </>
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

function renderContent(
  toolName: string | null,
  text: string,
  content: string | ConsumerContentBlock[],
  isError?: boolean,
): React.ReactNode {
  switch (toolName) {
    case "Bash": {
      const stripped = stripAnsi(text);
      if (containsUnifiedDiff(stripped)) {
        return <UnifiedDiffBlock text={stripped} isError={isError} />;
      }
      return <PreBlock text={stripped} isError={isError} showLineNumbers />;
    }
    case "Read":
    case "Write":
    case "Edit":
      return <PreBlock text={text} isError={isError} showLineNumbers />;
    case "Grep":
      return <PreBlock text={text} isError={isError} processLine={highlightGrepLine} />;
    case "Glob":
      return <PreBlock text={text} isError={isError} />;
    case "WebFetch":
    case "WebSearch":
      return <MarkdownBlock text={text} />;
    default:
      return <JsonBlock content={content} />;
  }
}
