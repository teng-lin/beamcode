import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsumerContentBlock } from "../../../shared/consumer-types";
import { stripAnsi } from "../utils/ansi-strip";
import { MarkdownContent } from "./MarkdownContent";

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

function truncateLines(text: string, max: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, truncated: false };
  return { text: lines.slice(0, max).join("\n"), truncated: true };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute right-2 top-2 rounded bg-bc-surface-2 px-1.5 py-0.5 text-[10px] text-bc-text-muted opacity-0 transition-opacity group-hover/pre:opacity-100 hover:bg-bc-hover hover:text-bc-text"
      aria-label="Copy to clipboard"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
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
  const allLines = text.split("\n");
  const totalLineCount = allLines.length;
  const { text: displayed, truncated } = expanded
    ? { text, truncated: false }
    : truncateLines(text, MAX_LINES);

  const lines = displayed.split("\n");
  const gutterWidth = String(totalLineCount).length;

  return (
    <div className="group/pre relative">
      <CopyButton text={text} />
      <pre
        className={`max-h-80 overflow-auto bg-bc-code-bg p-3 font-mono-code text-xs leading-relaxed whitespace-pre-wrap ${
          isError ? "text-bc-error/80" : "text-bc-text-muted"
        }`}
      >
        {/* biome-ignore lint/suspicious/noArrayIndexKey: static line content, never reorders */}
        {showLineNumbers
          ? lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static line content
              <div key={i} className="flex">
                <span
                  className="mr-3 inline-block select-none text-right text-bc-text-muted/30"
                  style={{ minWidth: `${gutterWidth}ch` }}
                >
                  {i + 1}
                </span>
                <span className="flex-1">{processLine ? processLine(line, i) : line}</span>
              </div>
            ))
          : processLine
            ? // biome-ignore lint/suspicious/noArrayIndexKey: static line content
              lines.map((line, i) => <div key={i}>{processLine(line, i)}</div>)
            : displayed}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-bc-border/30 px-3 py-1.5 text-center text-[11px] text-bc-text-muted/70 transition-colors hover:bg-bc-hover hover:text-bc-text"
        >
          Show all ({totalLineCount} lines)
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
    case "Bash":
      return <PreBlock text={stripAnsi(text)} isError={isError} showLineNumbers />;
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
