import type { ResultData } from "../../../shared/consumer-types";
import { formatCost, formatDuration, formatTokens } from "../utils/format";

interface ResultBannerProps {
  data: ResultData;
}

export function ResultBanner({ data }: ResultBannerProps) {
  const isError = data.is_error;
  const totalTokens = data.usage.input_tokens + data.usage.output_tokens;

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs ${
        isError
          ? "border border-bc-error/20 bg-bc-error/5 text-bc-error"
          : "border border-bc-success/20 bg-bc-success/5 text-bc-success"
      }`}
    >
      {isError ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="currentColor"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <path d="M6 0a6 6 0 110 12A6 6 0 016 0zM4.5 3.8L6 5.3l1.5-1.5.7.7L6.7 6l1.5 1.5-.7.7L6 6.7 4.5 8.2l-.7-.7L5.3 6 3.8 4.5l.7-.7z" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="currentColor"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <path d="M6 0a6 6 0 110 12A6 6 0 016 0zm2.7 4.3a.5.5 0 00-.7 0L5.5 6.8 4 5.3a.5.5 0 00-.7.7l2 2a.5.5 0 00.7 0l3-3a.5.5 0 000-.7z" />
        </svg>
      )}
      <span className="font-medium">{isError ? "Error" : "Done"}</span>
      <span className="text-bc-text-muted/50">—</span>
      <span className="tabular-nums text-bc-text-muted">{formatDuration(data.duration_ms)}</span>
      <span className="text-bc-text-muted/30">·</span>
      <span className="tabular-nums text-bc-text-muted">{formatCost(data.total_cost_usd)}</span>
      <span className="text-bc-text-muted/30">·</span>
      <span className="tabular-nums text-bc-text-muted">{formatTokens(totalTokens)} tokens</span>
      {(data.total_lines_added != null || data.total_lines_removed != null) && (
        <>
          <span className="text-bc-text-muted/30">·</span>
          <span className="tabular-nums text-bc-success">+{data.total_lines_added ?? 0}</span>
          <span className="tabular-nums text-bc-error">-{data.total_lines_removed ?? 0}</span>
        </>
      )}
    </div>
  );
}
