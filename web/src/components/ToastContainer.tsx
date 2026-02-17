import { useEffect } from "react";
import { type Toast, useStore } from "../store";

const TYPE_STYLES: Record<Toast["type"], string> = {
  info: "border-bc-accent/30 bg-bc-surface text-bc-text",
  success: "border-bc-success/30 bg-bc-success/10 text-bc-success",
  error: "border-bc-error/30 bg-bc-error/10 text-bc-error",
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useStore((s) => s.removeToast);

  useEffect(() => {
    if (toast.ttl <= 0) return;
    const timer = setTimeout(() => removeToast(toast.id), toast.ttl);
    return () => clearTimeout(timer);
  }, [toast.id, toast.ttl, removeToast]);

  return (
    <div
      className={`animate-fadeSlideIn flex items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-md ${TYPE_STYLES[toast.type]}`}
      role="alert"
    >
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={() => removeToast(toast.id)}
        className="flex-shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M2 2l6 6M8 2l-6 6"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
