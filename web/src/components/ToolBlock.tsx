import { useState } from "react";
import { useStore } from "../store";

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

  return (
    <div className="rounded border border-bc-border bg-bc-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
      >
        <span className="font-medium text-bc-accent">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono-code text-bc-text-muted">{preview}</span>
        {progress && (
          <span className="text-bc-text-muted">{progress.elapsedSeconds.toFixed(0)}s</span>
        )}
        <span className="text-bc-text-muted">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <pre className="max-h-60 overflow-auto border-t border-bc-border bg-bc-code-bg p-2 font-mono-code text-xs text-bc-text-muted">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}
