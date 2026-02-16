import { useCallback, useEffect, useRef } from "react";

interface ResizeDividerProps {
  onResize: (fraction: number) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function ResizeDivider({ onResize, containerRef }: ResizeDividerProps) {
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount — prevents leaked listeners if unmounted mid-drag
  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      document.body.style.userSelect = "none";
      let lastX = e.clientX;
      let rafId = 0;

      const onMove = (me: MouseEvent) => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          const containerWidth = Math.max(containerRef.current?.clientWidth ?? 1, 1);
          const delta = (me.clientX - lastX) / containerWidth;
          lastX = me.clientX;
          onResize(delta);
        });
      };
      const cleanup = () => {
        cancelAnimationFrame(rafId);
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", cleanup);
        cleanupRef.current = null;
      };

      cleanupRef.current = cleanup;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", cleanup);
    },
    [onResize, containerRef],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: interactive resize handle requires div, not hr
    <div
      className="w-1 cursor-col-resize bg-bc-border/50 transition-colors hover:bg-bc-accent/50 active:bg-bc-accent"
      onMouseDown={handleMouseDown}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={50}
      aria-label="Resize pane divider"
    />
  );
}
