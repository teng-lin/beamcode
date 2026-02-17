import { useLayoutEffect, useRef } from "react";
import { useStore } from "../store";

interface UserMessageBubbleProps {
  content: string;
  sessionId: string;
}

export function UserMessageBubble({ content, sessionId }: UserMessageBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hasFlipOrigin = useStore((s) => s.sessionData[sessionId]?.flipOrigin !== null);

  // FLIP animation: if flipOrigin exists, this user_message is the echo of a sent queued message.
  // Reads store imperatively to avoid re-running on flipOrigin changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const store = useStore.getState();
    const origin = store.sessionData[sessionId]?.flipOrigin;
    if (!origin) return;

    // Last: measure where the element actually rendered
    const lastRect = el.getBoundingClientRect();

    // Invert: calculate the delta from queued position to final position
    const deltaY = origin.top - lastRect.top;
    const deltaX = origin.left - lastRect.left;

    // Apply the invert transform immediately (element appears at the old position)
    el.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    el.style.opacity = "0.5";
    el.style.transition = "none";

    // Clear the flipOrigin so no other message picks it up
    store.setFlipOrigin(sessionId, null);

    // Play: in the next frame, remove the transform to animate to final position
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = "transform 400ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms ease";
        el.style.transform = "";
        el.style.opacity = "";
      });
    });
  }, [sessionId]);

  return (
    <div
      ref={ref}
      className={`self-start rounded-2xl bg-bc-user-bg px-4 py-2.5 text-sm max-w-[85%] border border-bc-border/30${hasFlipOrigin ? "" : " animate-fadeSlideIn"}`}
    >
      {content}
    </div>
  );
}
