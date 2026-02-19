import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { createSession } from "../api";
import type { SessionData } from "../store";
import { useStore } from "../store";
import { updateSessionUrl } from "../utils/session";
import { connectToSession } from "../ws";
import { AgentPane } from "./AgentPane";
import { AuthBanner } from "./AuthBanner";
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

  const identityRole = useStore((s) => s.sessionData[sessionId]?.identity?.role ?? null);
  const isObserver = identityRole === "observer";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isObserver && (
        <div className="border-b border-bc-border bg-bc-text-muted/5 px-3 py-1.5 text-center text-xs text-bc-text-muted">
          You are observing this session (read-only)
        </div>
      )}

      {!cliConnected && connectionStatus === "connected" && (
        <ConnectionBanner reconnectAttempt={sessionData.reconnectAttempt} />
      )}

      <AuthBanner sessionId={sessionId} />

      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <MessageFeed messages={messages} sessionId={sessionId} />
      )}

      <StreamingIndicator sessionId={sessionId} />

      {hasPendingPermissions && !isObserver && <PermissionBanner sessionId={sessionId} />}

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

const MIN_MAIN_RATIO = 0.3;
const MAX_MAIN_RATIO = 0.6;

/** Static disabled composer shown when no session is selected. */
function DisabledComposer() {
  return (
    <div className="rounded-xl border border-bc-border bg-bc-surface opacity-60">
      <textarea
        disabled
        rows={3}
        placeholder="Create a session to start..."
        className="min-h-[80px] w-full resize-none bg-transparent px-4 py-3 text-sm text-bc-text placeholder:text-bc-text-muted/60 disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-1 px-3 pb-2 pt-1">
        <button
          type="button"
          disabled
          className="flex h-7 w-7 items-center justify-center rounded-lg text-bc-text-muted/30"
          aria-label="Attach image"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <div className="flex-1" />
        <button
          type="button"
          disabled
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-bc-surface-2 text-bc-text-muted/30 shadow-none"
          aria-label="Send message"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 12V4M8 4L4 8M8 4l4 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function ChatView() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessionData = useStore((s) =>
    s.currentSessionId ? s.sessionData[s.currentSessionId] : null,
  );
  const hasNoSessions = useStore((s) => Object.keys(s.sessions).length === 0);
  const inspectedAgentId = useStore((s) => s.inspectedAgentId);
  const setInspectedAgent = useStore((s) => s.setInspectedAgent);
  const updateSession = useStore((s) => s.updateSession);
  const setCurrentSession = useStore((s) => s.setCurrentSession);

  const [splitRatio, setSplitRatio] = useState(0.45);
  const splitRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback((delta: number) => {
    setSplitRatio((prev) => Math.max(MIN_MAIN_RATIO, Math.min(MAX_MAIN_RATIO, prev + delta)));
  }, []);

  const handleAdapterSelect = useCallback(
    async (adapter: string) => {
      try {
        const session = await createSession({ adapter });
        updateSession(session.sessionId, session);
        setCurrentSession(session.sessionId);
        connectToSession(session.sessionId);
        updateSessionUrl(session.sessionId, "push");
      } catch (err) {
        console.error("[ChatView] Failed to create session:", err);
      }
    },
    [updateSession, setCurrentSession],
  );

  if (!currentSessionId || !sessionData) {
    // Show adapter picker when no sessions exist at all
    if (hasNoSessions) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <EmptyState onAdapterSelect={handleAdapterSelect} />
        </div>
      );
    }

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
          <div className="w-full max-w-3xl">
            <DisabledComposer />
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
