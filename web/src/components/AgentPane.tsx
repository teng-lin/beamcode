import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { useStore } from "../store";
import type { TaskToolInput } from "../utils/team-styles";
import {
  EMPTY_MEMBERS,
  EMPTY_MESSAGES,
  memberStatusDotClass,
  shortAgentType,
} from "../utils/team-styles";
import { MarkdownContent } from "./MarkdownContent";
import { MessageBubble } from "./MessageBubble";

function AgentStreamingIndicator({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const stream = useStore((s) => s.sessionData[sessionId]?.agentStreaming[agentId]);
  if (!stream?.text && !stream?.startedAt) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      {stream.text && <MarkdownContent content={stream.text} />}
      <div className="flex items-center gap-2 py-1.5 text-xs text-bc-text-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-bc-accent" />
        <span className="text-bc-accent/80">Generating...</span>
      </div>
    </div>
  );
}

interface AgentPaneProps {
  agentId: string;
  sessionId: string;
  onClose: () => void;
}

export function AgentPane({ agentId, sessionId, onClose }: AgentPaneProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const teamMembers = useStore(
    useShallow((s) => s.sessionData[sessionId]?.state?.team?.members ?? EMPTY_MEMBERS),
  );
  const messages = useStore(
    useShallow((s) => s.sessionData[sessionId]?.messages ?? EMPTY_MESSAGES),
  );

  // Static metadata (name, type) — only changes if messages or agentId change
  const agentMetadata = useMemo(() => {
    for (const msg of messages) {
      if (msg.type !== "assistant" || msg.parent_tool_use_id) continue;
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.id === agentId) {
          const input = block.input as TaskToolInput;
          return { name: input.name ?? "Agent", type: input.subagent_type ?? "" };
        }
      }
    }
    return { name: "Agent", type: "" };
  }, [messages, agentId]);

  // Live status — updates when team members change (cheap lookup)
  const agentMeta = useMemo(() => {
    const member = teamMembers.find((m) => m.name === agentMetadata.name);
    return { ...agentMetadata, status: member?.status ?? "active" };
  }, [agentMetadata, teamMembers]);

  const agentMessages = useMemo(
    () => messages.filter((m) => m.type === "assistant" && m.parent_tool_use_id === agentId),
    [messages, agentId],
  );

  const statusDotClass = memberStatusDotClass(agentMeta.status);

  // Auto-scroll on new messages
  // biome-ignore lint/correctness/useExhaustiveDependencies: length triggers scroll
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [agentMessages.length]);

  return (
    <div className="flex h-full flex-col border-l border-bc-border bg-bc-bg max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-full">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-bc-border px-3 py-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass}`}
          title={`Status: ${agentMeta.status}`}
        />
        <span className="truncate text-sm font-medium text-bc-text">{agentMeta.name}</span>
        {agentMeta.type && (
          <span className="text-xs text-bc-text-muted">{shortAgentType(agentMeta.type)}</span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent pane"
          className="rounded p-1 text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Messages */}
      {agentMessages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-bc-text-muted">
          Waiting for agent output...
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {agentMessages.map((msg) => {
              if (msg.type !== "assistant") return null;
              return <MessageBubble key={msg.message.id} message={msg} sessionId={sessionId} />;
            })}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      <AgentStreamingIndicator sessionId={sessionId} agentId={agentId} />
    </div>
  );
}
