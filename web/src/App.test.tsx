import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./store";
import { makeSessionInfo, resetStore, store } from "./test/factories";

// ── Mocks ──────────────────────────────────────────────────────────────────

const listSessionsMock = vi.fn<() => Promise<SessionInfo[]>>(() => Promise.resolve([]));
vi.mock("./api", () => ({ listSessions: () => listSessionsMock() }));

const connectToSessionMock = vi.fn();
vi.mock("./ws", () => ({
  connectToSession: (...args: unknown[]) => connectToSessionMock(...args),
  disconnectSession: vi.fn(),
  send: vi.fn(),
}));

vi.mock("./components/ChatView", () => ({
  ChatView: () => <div data-testid="chat-view" />,
}));
vi.mock("./components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
vi.mock("./components/TopBar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));
vi.mock("./components/TaskPanel", () => ({
  TaskPanel: () => <div data-testid="task-panel" />,
}));
vi.mock("./components/LogDrawer", () => ({
  LogDrawer: () => <div data-testid="log-drawer" />,
}));
vi.mock("./components/ToastContainer", () => ({
  ToastContainer: () => null,
}));
vi.mock("./components/ShortcutsModal", () => ({
  ShortcutsModal: () => null,
}));
vi.mock("./components/QuickSwitcher", () => ({
  QuickSwitcher: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="quick-switcher">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

// ── Import App AFTER mocks are set up ──────────────────────────────────────

const { default: App, ErrorBoundary } = await import("./App");

// ── Helpers ────────────────────────────────────────────────────────────────

function setUrlParam(key: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState({}, "", url.toString());
}

function clearUrlParams(): void {
  window.history.replaceState({}, "", window.location.pathname);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("App", () => {
  beforeEach(() => {
    resetStore({ sidebarOpen: false, taskPanelOpen: false, logDrawerOpen: false, darkMode: true });
    vi.clearAllMocks();
    clearUrlParams();
    document.documentElement.classList.remove("dark");
  });

  // ── Bootstrap ────────────────────────────────────────────────────────

  describe("bootstrap", () => {
    it("calls listSessions on mount", async () => {
      render(<App />);
      await waitFor(() => {
        expect(listSessionsMock).toHaveBeenCalledTimes(1);
      });
    });

    it("connects to session from ?session= URL param", async () => {
      setUrlParam("session", "sess-42");
      render(<App />);
      await waitFor(() => {
        expect(connectToSessionMock).toHaveBeenCalledWith("sess-42");
      });
    });

    it("handles listSessions failure gracefully without crashing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      listSessionsMock.mockRejectedValueOnce(new Error("network down"));

      render(<App />);

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          "[bootstrap] Failed to load sessions:",
          expect.any(Error),
        );
      });
      // App still renders without crashing
      expect(screen.getByTestId("chat-view")).toBeInTheDocument();
      warnSpy.mockRestore();
    });

    it("populates store sessions from API response", async () => {
      const sessions = [makeSessionInfo({ sessionId: "s1" }), makeSessionInfo({ sessionId: "s2" })];
      listSessionsMock.mockResolvedValueOnce(sessions);

      render(<App />);

      await waitFor(() => {
        const stored = store().sessions;
        expect(stored.s1).toBeDefined();
        expect(stored.s2).toBeDefined();
        expect(stored.s1.sessionId).toBe("s1");
      });
    });
  });

  // ── Dark mode ────────────────────────────────────────────────────────

  describe("dark mode", () => {
    it('applies "dark" class to documentElement when darkMode is true', async () => {
      resetStore({ darkMode: true });
      render(<App />);
      await waitFor(() => {
        expect(document.documentElement.classList.contains("dark")).toBe(true);
      });
    });

    it('removes "dark" class when darkMode is false', async () => {
      document.documentElement.classList.add("dark");
      resetStore({ darkMode: false });
      render(<App />);
      await waitFor(() => {
        expect(document.documentElement.classList.contains("dark")).toBe(false);
      });
    });
  });

  // ── Layout ───────────────────────────────────────────────────────────

  describe("layout", () => {
    it("renders sidebar when sidebarOpen is true", () => {
      resetStore({ sidebarOpen: true });
      render(<App />);
      expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    });

    it("hides sidebar when sidebarOpen is false", () => {
      resetStore({ sidebarOpen: false });
      render(<App />);
      expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    });

    it("renders task panel when taskPanelOpen is true", () => {
      resetStore({ taskPanelOpen: true });
      render(<App />);
      expect(screen.getByTestId("task-panel")).toBeInTheDocument();
    });

    it("hides task panel when taskPanelOpen is false", () => {
      resetStore({ taskPanelOpen: false });
      render(<App />);
      expect(screen.queryByTestId("task-panel")).not.toBeInTheDocument();
    });

    it("renders log drawer when logDrawerOpen is true", () => {
      resetStore({ logDrawerOpen: true });
      render(<App />);
      expect(screen.getByTestId("log-drawer")).toBeInTheDocument();
    });

    it("hides log drawer when logDrawerOpen is false", () => {
      resetStore({ logDrawerOpen: false });
      render(<App />);
      expect(screen.queryByTestId("log-drawer")).not.toBeInTheDocument();
    });

    it("renders mobile backdrop with Close sidebar label when sidebar is open", () => {
      resetStore({ sidebarOpen: true });
      render(<App />);
      expect(screen.getByLabelText("Close sidebar")).toBeInTheDocument();
    });

    it("does not render mobile backdrop when sidebar is closed", () => {
      resetStore({ sidebarOpen: false });
      render(<App />);
      expect(screen.queryByLabelText("Close sidebar")).not.toBeInTheDocument();
    });
  });

  // ── ErrorBoundary (real export from App.tsx) ─────────────────────────

  describe("ErrorBoundary", () => {
    function ThrowingChild(): never {
      throw new Error("boom");
    }

    it("shows fallback UI when child throws", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(
        <ErrorBoundary fallback="Something went wrong">
          <ThrowingChild />
        </ErrorBoundary>,
      );
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("boom")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      spy.mockRestore();
    });

    it("clears error state when Retry button is clicked", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      let shouldThrow = true;

      function MaybeThrows() {
        if (shouldThrow) throw new Error("boom");
        return <div data-testid="recovered">OK</div>;
      }

      const user = userEvent.setup();
      render(
        <ErrorBoundary fallback="Something went wrong">
          <MaybeThrows />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();

      shouldThrow = false;
      await user.click(screen.getByRole("button", { name: "Retry" }));

      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
      expect(screen.getByTestId("recovered")).toBeInTheDocument();
      spy.mockRestore();
    });

    it("logs error and component stack via componentDidCatch", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(
        <ErrorBoundary fallback="oops">
          <ThrowingChild />
        </ErrorBoundary>,
      );
      expect(spy).toHaveBeenCalledWith("[ErrorBoundary]", expect.any(Error), expect.any(String));
      spy.mockRestore();
    });
  });
});
