import { useStore } from "../store";
import { Composer } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { EmptyState } from "./EmptyState";
import { MessageFeed } from "./MessageFeed";
import { PermissionBanner } from "./PermissionBanner";
import { StreamingIndicator } from "./StreamingIndicator";

export function ChatView() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessionData = useStore((s) =>
    s.currentSessionId ? s.sessionData[s.currentSessionId] : null,
  );

  if (!currentSessionId || !sessionData) {
    return <EmptyState />;
  }

  const { messages, cliConnected, connectionStatus } = sessionData;
  const hasPendingPermissions = Object.keys(sessionData.pendingPermissions).length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!cliConnected && connectionStatus === "connected" && (
        <ConnectionBanner reconnectAttempt={sessionData.reconnectAttempt} />
      )}

      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <MessageFeed messages={messages} sessionId={currentSessionId} />
      )}

      <StreamingIndicator sessionId={currentSessionId} />

      {hasPendingPermissions && <PermissionBanner sessionId={currentSessionId} />}

      <Composer sessionId={currentSessionId} />
    </div>
  );
}
