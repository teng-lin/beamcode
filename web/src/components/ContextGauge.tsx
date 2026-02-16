interface ContextGaugeProps {
  percent: number;
}

function gaugeColor(percent: number): string {
  if (percent >= 80) return "bg-bc-error";
  if (percent >= 60) return "bg-bc-warning";
  return "bg-bc-success";
}

function warningLevel(percent: number): string | null {
  if (percent >= 90) return "Critical — consider compacting";
  if (percent >= 75) return "High usage";
  return null;
}

export function ContextGauge({ percent }: ContextGaugeProps) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const color = gaugeColor(clamped);
  const warning = warningLevel(clamped);

  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-bc-surface-2"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Context window ${clamped}% used`}
        title={`${clamped.toFixed(1)}% used`}
      >
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-bc-text-muted">
        <span>{clamped.toFixed(0)}%</span>
        {warning && (
          <span className={clamped >= 90 ? "text-bc-error" : "text-bc-warning"}>{warning}</span>
        )}
      </div>
    </div>
  );
}
