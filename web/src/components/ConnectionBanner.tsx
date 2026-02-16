export function ConnectionBanner() {
  return (
    <div
      className="flex items-center justify-center gap-2 bg-bc-warning/10 px-3 py-1.5 text-xs text-bc-warning"
      role="alert"
    >
      <span className="h-2 w-2 rounded-full border border-bc-warning" />
      CLI disconnected — waiting for reconnection
    </div>
  );
}
