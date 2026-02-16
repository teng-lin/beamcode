import { memo, useEffect, useRef } from "react";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { useStore } from "../store";
import { memberStatusDotClass, shortAgentType } from "../utils/team-styles";
import { MarkdownContent } from "./MarkdownContent";
import { MessageBubble } from "./MessageBubble";

type AssistantMessage = Extract<ConsumerMessage, { type: "assistant" }>;

function AgentColumnStreamingIndicator({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}) {
  const stream = useStore((s) => s.sessionData[sessionId]?.agentStreaming[agentId]);
  if (!stream?.text && !stream?.startedAt) return null;
  return (
    <div className="px-2 pb-1">
      {stream.text && <MarkdownContent content={stream.text} />}
      <div className="flex items-center gap-1.5 py-1 text-[10px] text-bc-text-muted">
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-bc-accent" />
        <span className="text-bc-accent/80">Generating...</span>
      </div>
    </div>
  );
}

interface AgentColumnProps {
  agentId: string;
  name: string;
  type: string;
  status: "active" | "idle" | "shutdown";
  messages: AssistantMessage[];
  sessionId: string;
}

export const AgentColumn = memo(function AgentColumn({
  agentId,
  name,
  type,
  status,
  messages,
  sessionId,
}: AgentColumnProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const statusDotClass = memberStatusDotClass(status);

  // Auto-scroll on new messages
  // biome-ignore lint/correctness/useExhaustiveDependencies: length triggers scroll
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  return (
    <div className="flex min-w-[200px] flex-col border-l border-bc-border bg-bc-bg">
      {/* Compact header */}
      <div className="flex items-center gap-1.5 border-b border-bc-border px-2 py-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass}`}
          title={`Status: ${status}`}
        />
        <span className="truncate text-xs font-medium text-bc-text">{name}</span>
        {type && (
          <span className="truncate text-[10px] text-bc-text-muted">{shortAgentType(type)}</span>
        )}
      </div>

      {/* Messages */}
      {messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[10px] text-bc-text-muted">
          Waiting...
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex flex-col gap-1.5">
            {messages.map((msg) => (
              <MessageBubble key={msg.message.id} message={msg} sessionId={sessionId} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      <AgentColumnStreamingIndicator sessionId={sessionId} agentId={agentId} />
    </div>
  );
});
