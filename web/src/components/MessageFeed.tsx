import { useEffect, useMemo, useRef } from "react";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { MessageBubble } from "./MessageBubble";
import { ResultBanner } from "./ResultBanner";

interface MessageFeedProps {
  messages: ConsumerMessage[];
  sessionId: string;
}

interface MessageGroup {
  type: "single" | "tool_group" | "subagent";
  messages: ConsumerMessage[];
  parentToolUseId?: string;
  key: string;
}

function groupMessages(messages: ConsumerMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let groupIndex = 0;

  for (const msg of messages) {
    if (msg.type === "assistant" && msg.parent_tool_use_id) {
      // Find existing subagent group or create new one
      const existing = groups.find(
        (g) => g.type === "subagent" && g.parentToolUseId === msg.parent_tool_use_id,
      );
      if (existing) {
        existing.messages.push(msg);
      } else {
        groups.push({
          type: "subagent",
          messages: [msg],
          parentToolUseId: msg.parent_tool_use_id,
          key: `subagent-${msg.parent_tool_use_id}`,
        });
        groupIndex++;
      }
    } else {
      groups.push({ type: "single", messages: [msg], key: `msg-${groupIndex}` });
      groupIndex++;
    }
  }

  return groups;
}

export function MessageFeed({ messages, sessionId }: MessageFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupMessages(messages), [messages]);

  // Only auto-scroll if user is already near the bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length triggers scroll on new messages
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    if (!isNearBottom) return;
    const frame = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-3"
      role="log"
      aria-live="polite"
      aria-label="Message history"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {groups.map((group) => {
          if (group.type === "subagent") {
            return (
              <details
                key={group.key}
                className="rounded-lg border border-bc-border/50 bg-bc-surface/30"
              >
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="flex-shrink-0"
                    aria-hidden="true"
                  >
                    <rect
                      x="1"
                      y="3"
                      width="7"
                      height="6"
                      rx="1"
                      stroke="currentColor"
                      strokeWidth="1"
                      opacity="0.5"
                    />
                    <rect
                      x="4"
                      y="1"
                      width="7"
                      height="6"
                      rx="1"
                      stroke="currentColor"
                      strokeWidth="1"
                      opacity="0.3"
                    />
                  </svg>
                  <span>Subagent</span>
                  <span className="rounded-full bg-bc-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums">
                    {group.messages.length}
                  </span>
                </summary>
                <div className="flex flex-col gap-2 border-t border-bc-border/30 p-2.5">
                  {group.messages.map((msg, j) => (
                    <MessageBubble key={`${group.key}-${j}`} message={msg} sessionId={sessionId} />
                  ))}
                </div>
              </details>
            );
          }

          const msg = group.messages[0];
          if (msg.type === "result") {
            return <ResultBanner key={group.key} data={msg.data} />;
          }

          return <MessageBubble key={group.key} message={msg} sessionId={sessionId} />;
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
