import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";
import { listSessions } from "./api";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { TaskPanel } from "./components/TaskPanel";
import { TopBar } from "./components/TopBar";
import { useStore } from "./store";
import { connectToSession } from "./ws";

// ── Error Boundary ──────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState & { error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col gap-2 p-4">
          <div className="text-sm text-bc-error">{this.props.fallback}</div>
          {this.state.error && (
            <pre className="max-h-20 overflow-auto rounded bg-bc-surface-2 p-2 font-mono-code text-xs text-bc-text-muted">
              {this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="w-fit rounded bg-bc-surface-2 px-2 py-1 text-xs text-bc-text-muted hover:bg-bc-hover"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Bootstrap: read ?session= from URL, load sessions, connect WS ──────────

function useBootstrap() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session");

    // Load session list from API (non-blocking, populates sidebar)
    listSessions()
      .then((sessions) => {
        const byId: Record<string, (typeof sessions)[0]> = {};
        for (const s of sessions) byId[s.sessionId] = s;
        useStore.getState().setSessions(byId);
      })
      .catch((err) => console.warn("[bootstrap] Failed to load sessions:", err));

    // Connect WebSocket to the session from URL
    if (sessionId) {
      useStore.getState().setCurrentSession(sessionId);
      connectToSession(sessionId);
    }
  }, []);
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  useBootstrap();

  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const darkMode = useStore((s) => s.darkMode);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bc-bg text-bc-text">
      {/* Sidebar */}
      <ErrorBoundary fallback={<div className="p-4 text-bc-error">Sidebar error</div>}>
        {sidebarOpen && <Sidebar />}
      </ErrorBoundary>

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 cursor-default border-none bg-black/50 md:hidden"
          aria-label="Close sidebar"
          onClick={toggleSidebar}
          onKeyDown={(e) => {
            if (e.key === "Escape") toggleSidebar();
          }}
        />
      )}

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <ErrorBoundary fallback={<div className="flex-1 p-4 text-bc-error">Chat error</div>}>
          <ChatView />
        </ErrorBoundary>
      </div>

      {/* Task panel */}
      <ErrorBoundary fallback={<div className="p-4 text-bc-error">Panel error</div>}>
        {taskPanelOpen && <TaskPanel />}
      </ErrorBoundary>
    </div>
  );
}
