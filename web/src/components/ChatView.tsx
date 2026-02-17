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
import { StatusBar } from "./StatusBar";
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
      <StatusBar />
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
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Center logo + composer vertically */}
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          {/* Inline logo — EmptyState uses flex-1 which breaks centering here */}
          <div className="relative mb-6 text-center">
            <div className="absolute left-1/2 top-1/2 -z-10 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bc-accent/[0.06] blur-3xl" />
            <div className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-bc-border bg-bc-surface">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
                <path
                  d="M14 3L24 8.5v11L14 25 4 19.5v-11L14 3z"
                  stroke="var(--color-bc-accent)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <circle cx="14" cy="14" r="3" fill="var(--color-bc-accent)" opacity="0.8" />
              </svg>
            </div>
            <h2 className="mb-1.5 text-lg font-semibold tracking-tight text-bc-text">BeamCode</h2>
            <p className="text-sm text-bc-text-muted">Send a message to start coding</p>
          </div>
          <div className="w-full max-w-xl">
            <div className="flex items-end gap-2">
              <textarea
                disabled
                rows={3}
                placeholder="Create a session to start..."
                className="min-h-[80px] w-full resize-none rounded-xl border border-bc-border bg-bc-bg px-4 py-3 text-sm text-bc-text placeholder:text-bc-text-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                disabled
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-bc-surface-2 text-bc-text-muted/30 shadow-none"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M3 13l10-5L3 3v4l6 1-6 1z" />
                </svg>
              </button>
            </div>
            <StatusBar />
          </div>
        </div>
      </div>
    );
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
