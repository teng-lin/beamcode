interface DiffViewProps {
  oldString: string;
  newString: string;
  filePath?: string;
  maxLines?: number;
}

interface DiffLine {
  type: "added" | "removed";
  text: string;
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const removed = oldStr
    ? oldStr.split("\n").map((text): DiffLine => ({ type: "removed", text }))
    : [];
  const added = newStr ? newStr.split("\n").map((text): DiffLine => ({ type: "added", text })) : [];
  return [...removed, ...added];
}

export function DiffView({ oldString, newString, filePath, maxLines = 40 }: DiffViewProps) {
  const allLines = computeDiff(oldString, newString);
  const truncated = allLines.length > maxLines;
  const lines = truncated ? allLines.slice(0, maxLines) : allLines;

  return (
    <div className="overflow-hidden rounded-lg border border-bc-border/60 bg-bc-code-bg">
      {filePath && (
        <div className="border-b border-bc-border/40 px-3 py-1.5 font-mono-code text-[11px] text-bc-text-muted">
          {filePath}
        </div>
      )}
      <pre className="overflow-x-auto p-2 font-mono-code text-xs leading-relaxed">
        {lines.map((line, i) => {
          const prefix = line.type === "removed" ? "- " : "+ ";
          const color =
            line.type === "removed"
              ? "bg-bc-error/10 text-bc-error"
              : "bg-bc-success/10 text-bc-success";
          return (
            <div key={`${line.type}-${i}`} className={`px-1 ${color}`} data-diff={line.type}>
              {prefix}
              {line.text}
            </div>
          );
        })}
        {truncated && (
          <div className="mt-1 px-1 text-bc-text-muted/60 italic">
            ... truncated ({allLines.length - maxLines} more lines)
          </div>
        )}
      </pre>
    </div>
  );
}
