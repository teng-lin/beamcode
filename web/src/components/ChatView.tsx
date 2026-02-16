import { useCallback, useRef, useState } from "react";
import type { SessionData } from "../store";
import { useStore } from "../store";
import { AgentPane } from "./AgentPane";
import { Composer } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { EmptyState } from "./EmptyState";
import { MessageFeed } from "./MessageFeed";
import { PermissionBanner } from "./PermissionBanner";
import { ResizeDivider } from "./ResizeDivider";
import { StreamingIndicator } from "./StreamingIndicator";

function MainChatContent({
  sessionId,
  sessionData,
}: {
  sessionId: string;
  sessionData: SessionData;
}) {
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
        <MessageFeed messages={messages} sessionId={sessionId} />
      )}

      <StreamingIndicator sessionId={sessionId} />

      {hasPendingPermissions && <PermissionBanner sessionId={sessionId} />}

      <Composer sessionId={sessionId} />
    </div>
  );
}

export function ChatView() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessionData = useStore((s) =>
    s.currentSessionId ? s.sessionData[s.currentSessionId] : null,
  );
  const inspectedAgentId = useStore((s) => s.inspectedAgentId);
  const setInspectedAgent = useStore((s) => s.setInspectedAgent);

  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback((delta: number) => {
    setSplitRatio((prev) => Math.max(0.25, Math.min(0.75, prev + delta)));
  }, []);

  if (!currentSessionId || !sessionData) {
    return <EmptyState />;
  }

  if (!inspectedAgentId) {
    return <MainChatContent sessionId={currentSessionId} sessionData={sessionData} />;
  }

  return (
    <div ref={splitRef} className="flex min-h-0 flex-1">
      <div style={{ flexBasis: `${splitRatio * 100}%` }} className="flex min-w-0 flex-col">
        <MainChatContent sessionId={currentSessionId} sessionData={sessionData} />
      </div>
      <ResizeDivider onResize={handleResize} containerRef={splitRef} value={splitRatio} />
      <div style={{ flexBasis: `${(1 - splitRatio) * 100}%` }} className="min-w-0">
        <AgentPane
          agentId={inspectedAgentId}
          sessionId={currentSessionId}
          onClose={() => setInspectedAgent(null)}
        />
      </div>
    </div>
  );
}
