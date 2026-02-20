import { memo } from "react";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessageBubble } from "./UserMessageBubble";

interface MessageBubbleProps {
  message: ConsumerMessage;
  sessionId: string;
}

function renderToolPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null) return "null";
  if (payload === undefined) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export const MessageBubble = memo(function MessageBubble({
  message,
  sessionId,
}: MessageBubbleProps) {
  switch (message.type) {
    case "user_message":
      return <UserMessageBubble content={message.content} sessionId={sessionId} />;

    case "assistant":
      return <AssistantMessage message={message.message} sessionId={sessionId} />;

    case "error":
      return (
        <div className="animate-fadeSlideIn flex items-start gap-2 rounded-lg border border-bc-error/30 bg-bc-error/10 px-3 py-2 text-sm text-bc-error">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="currentColor"
            className="mt-0.5 flex-shrink-0"
            aria-hidden="true"
          >
            <path d="M7 0a7 7 0 110 14A7 7 0 017 0zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zM7 3a.75.75 0 00-.75.75v4a.75.75 0 001.5 0v-4A.75.75 0 007 3z" />
          </svg>
          <span>{message.message}</span>
        </div>
      );

    case "slash_command_result":
      return (
        <div className="animate-fadeSlideIn rounded-lg border border-bc-border/50 bg-bc-surface px-3 py-2.5 text-sm">
          <span className="mb-1.5 inline-block rounded bg-bc-accent/15 px-1.5 py-0.5 font-mono-code text-[11px] text-bc-accent">
            {message.command}
          </span>
          <pre className="whitespace-pre-wrap font-mono-code text-xs text-bc-text-muted leading-relaxed">
            {message.content}
          </pre>
        </div>
      );

    case "slash_command_error":
      return (
        <div className="animate-fadeSlideIn rounded-lg border border-bc-error/30 bg-bc-error/5 px-3 py-2.5 text-sm">
          <span className="mb-1.5 inline-block rounded bg-bc-error/15 px-1.5 py-0.5 font-mono-code text-[11px] text-bc-error">
            {message.command} failed
          </span>
          <pre className="whitespace-pre-wrap font-mono-code text-xs text-bc-text-muted">
            {message.error}
          </pre>
        </div>
      );

    case "tool_use_summary": {
      const outputText = renderToolPayload(message.output);
      const errorText = renderToolPayload(message.error);

      return (
        <div className="animate-fadeSlideIn rounded-lg border border-bc-border/50 bg-bc-surface px-3 py-2.5 text-sm">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded bg-bc-accent/15 px-1.5 py-0.5 font-mono-code text-[11px] text-bc-accent">
              {message.tool_name ?? "tool"}
            </span>
            <span className="text-bc-text-muted">{message.summary}</span>
          </div>
          {outputText && (
            <pre className="whitespace-pre-wrap font-mono-code text-xs text-bc-text-muted leading-relaxed">
              {outputText}
            </pre>
          )}
          {errorText && (
            <pre className="whitespace-pre-wrap font-mono-code text-xs text-bc-error leading-relaxed">
              {errorText}
            </pre>
          )}
        </div>
      );
    }

    default:
      return null;
  }
});
