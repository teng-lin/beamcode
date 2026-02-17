import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared hook for dropdown menus with outside-click and Escape-to-close behavior.
 * Consolidates repeated event listener setup across StatusBar and TopBar components.
 *
 * @param resetKey - When this value changes, the dropdown is closed.
 *   Pass a session ID or similar primitive so the dropdown resets on context switch.
 */
export function useDropdown(resetKey?: unknown) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the dropdown whenever resetKey changes (e.g. session switch)
  const prevResetKey = useRef(resetKey);
  if (resetKey !== prevResetKey.current) {
    prevResetKey.current = resetKey;
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  return { open, setOpen, toggle, close, ref } as const;
}
