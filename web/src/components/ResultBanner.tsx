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
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-xs ${
        isError
          ? "border border-bc-error/20 bg-bc-error/5 text-bc-error"
          : "border border-bc-success/20 bg-bc-success/5 text-bc-success"
      }`}
    >
      <span className="font-medium">{isError ? "Error" : "Done"}</span>
      <span className="text-bc-text-muted">—</span>
      <span className="text-bc-text-muted">{formatDuration(data.duration_ms)}</span>
      <span className="text-bc-text-muted">·</span>
      <span className="text-bc-text-muted">{formatCost(data.total_cost_usd)}</span>
      <span className="text-bc-text-muted">·</span>
      <span className="text-bc-text-muted">{formatTokens(totalTokens)} tokens</span>
    </div>
  );
}
