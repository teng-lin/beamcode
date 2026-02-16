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
              <details key={group.key} className="rounded-md border border-bc-border">
                <summary className="cursor-pointer px-3 py-1.5 text-xs text-bc-text-muted hover:bg-bc-hover">
                  Subagent ({group.messages.length} messages)
                </summary>
                <div className="flex flex-col gap-2 p-2">
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
