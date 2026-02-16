import type { ReactNode } from "react";
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

interface SplitLayoutProps {
  splitRef: React.RefObject<HTMLDivElement | null>;
  splitRatio: number;
  onResize: (delta: number) => void;
  left: ReactNode;
  right: ReactNode;
  rightClassName?: string;
}

function SplitLayout({
  splitRef,
  splitRatio,
  onResize,
  left,
  right,
  rightClassName = "min-w-0",
}: SplitLayoutProps) {
  return (
    <div ref={splitRef} className="flex min-h-0 flex-1">
      <div style={{ flexBasis: `${splitRatio * 100}%` }} className="flex min-w-0 flex-col">
        {left}
      </div>
      <ResizeDivider onResize={onResize} containerRef={splitRef} value={splitRatio} />
      <div style={{ flexBasis: `${(1 - splitRatio) * 100}%` }} className={rightClassName}>
        {right}
      </div>
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

  const [splitRatio, setSplitRatio] = useState(0.45);
  const splitRef = useRef<HTMLDivElement>(null);

  const MIN_MAIN_RATIO = 0.3;
  const MAX_MAIN_RATIO = 0.6;
  const handleResize = useCallback((delta: number) => {
    setSplitRatio((prev) => Math.max(MIN_MAIN_RATIO, Math.min(MAX_MAIN_RATIO, prev + delta)));
  }, []);

  if (!currentSessionId || !sessionData) {
    return <EmptyState />;
  }

  const mainChat = <MainChatContent sessionId={currentSessionId} sessionData={sessionData} />;

  // Grid mode: disabled — background/team agents don't stream through
  // the parent's NDJSON output, so columns only show "Waiting...".
  // Re-enable when Anthropic adds --sdk-url propagation to child agents.
  // See: https://github.com/anthropics/claude-code/issues/1770
  // if (shouldShowGrid) { ... }

  // Single-agent inspection (legacy split-pane)
  if (inspectedAgentId) {
    return (
      <SplitLayout
        splitRef={splitRef}
        splitRatio={splitRatio}
        onResize={handleResize}
        left={mainChat}
        right={
          <AgentPane
            agentId={inspectedAgentId}
            sessionId={currentSessionId}
            onClose={() => setInspectedAgent(null)}
          />
        }
      />
    );
  }

  // Full-width main chat (no agents)
  return mainChat;
}
