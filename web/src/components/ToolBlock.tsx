import { useState } from "react";
import { useStore } from "../store";
import { DiffView } from "./DiffView";

interface ToolBlockProps {
  id: string;
  name: string;
  input: Record<string, unknown>;
  sessionId: string;
}

function toolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "");
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? "");
    case "Glob":
    case "Grep":
      return String(input.pattern ?? "");
    default:
      return name;
  }
}

export function ToolBlock({ id, name, input, sessionId }: ToolBlockProps) {
  const [open, setOpen] = useState(false);
  const progress = useStore((s) => s.sessionData[sessionId]?.toolProgress[id]);

  const preview = toolPreview(name, input);
  const isEditWithDiff = name === "Edit" && "old_string" in input;

  return (
    <div className="rounded-lg border border-bc-border/60 bg-bc-surface transition-colors hover:border-bc-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
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
          <path d="M4 6h4" stroke="var(--color-bc-accent)" strokeWidth="1.2" />
        </svg>
        <span className="font-medium text-bc-accent">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono-code text-bc-text-muted/80">
          {preview}
        </span>
        {progress && (
          <span className="tabular-nums text-bc-text-muted/60">
            {progress.elapsedSeconds.toFixed(0)}s
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          className={`flex-shrink-0 text-bc-text-muted/50 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M3.5 2L7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {open && isEditWithDiff && (
        <div className="border-t border-bc-border/50 p-2">
          <DiffView
            oldString={String(input.old_string ?? "")}
            newString={String(input.new_string ?? "")}
            filePath={String(input.file_path ?? "")}
          />
        </div>
      )}
      {open && !isEditWithDiff && (
        <pre className="max-h-60 overflow-auto border-t border-bc-border/50 bg-bc-code-bg p-3 font-mono-code text-xs text-bc-text-muted leading-relaxed">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}
