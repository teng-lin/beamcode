export function ConnectionBanner() {
  return (
    <div
      className="flex items-center justify-center gap-2 border-b border-bc-warning/20 bg-bc-warning/10 px-3 py-2 text-xs text-bc-warning"
      role="alert"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bc-warning" />
      CLI disconnected — waiting for reconnection
    </div>
  );
}
