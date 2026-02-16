import { memo } from "react";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { AssistantMessage } from "./AssistantMessage";

interface MessageBubbleProps {
  message: ConsumerMessage;
  sessionId: string;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  sessionId,
}: MessageBubbleProps) {
  switch (message.type) {
    case "user_message":
      return (
        <div className="animate-fadeSlideIn self-end rounded-xl bg-bc-user-bg px-4 py-2.5 text-sm max-w-[85%]">
          {message.content}
        </div>
      );

    case "assistant":
      return <AssistantMessage message={message.message} sessionId={sessionId} />;

    case "error":
      return (
        <div className="rounded-lg border border-bc-error/30 bg-bc-error/10 px-3 py-2 text-sm text-bc-error">
          {message.message}
        </div>
      );

    case "slash_command_result":
      return (
        <div className="rounded-lg bg-bc-surface-2 px-3 py-2 text-sm">
          <span className="mb-1 block text-xs text-bc-accent">/{message.command}</span>
          <pre className="whitespace-pre-wrap font-mono-code text-xs text-bc-text-muted">
            {message.content}
          </pre>
        </div>
      );

    case "slash_command_error":
      return (
        <div className="rounded-lg border border-bc-error/30 bg-bc-error/10 px-3 py-2 text-sm">
          <span className="mb-1 block text-xs text-bc-error">/{message.command} failed</span>
          <pre className="whitespace-pre-wrap font-mono-code text-xs">{message.error}</pre>
        </div>
      );

    default:
      return null;
  }
});
