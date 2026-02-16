import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { TaskPanel } from "./components/TaskPanel";
import { TopBar } from "./components/TopBar";
import { useStore } from "./store";

// ── Error Boundary ──────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center gap-2 p-4 text-bc-error">
          {this.props.fallback}
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="rounded bg-bc-surface-2 px-2 py-1 text-xs text-bc-text-muted hover:bg-bc-hover"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
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
