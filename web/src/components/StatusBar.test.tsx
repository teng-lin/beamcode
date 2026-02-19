import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { checkA11y } from "../test/a11y";
import { makeSessionInfo, resetStore, store } from "../test/factories";
import { StatusBar } from "./StatusBar";

vi.mock("../ws", () => ({
  send: vi.fn(),
}));

const SESSION = "statusbar-test";

// ── Helpers ────────────────────────────────────────────────────────────────

function setupSession(
  options?: Partial<{
    adapterType: string;
    model: string;
    cwd: string;
    permissionMode: string;
    git_branch: string;
    git_ahead: number;
    git_behind: number;
    is_worktree: boolean;
  }>,
): void {
  store().ensureSessionData(SESSION);
  useStore.setState({
    currentSessionId: SESSION,
    sessions: {
      [SESSION]: makeSessionInfo({
        sessionId: SESSION,
        adapterType: options?.adapterType ?? "claude",
      }),
    },
  });
  store().setSessionState(SESSION, {
    session_id: SESSION,
    model: options?.model ?? "claude-sonnet-4-20250514",
    cwd: options?.cwd ?? "/home/user/project",
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    permissionMode: options?.permissionMode ?? "default",
    git_branch: options?.git_branch ?? "main",
    git_ahead: options?.git_ahead ?? 0,
    git_behind: options?.git_behind ?? 0,
    is_worktree: options?.is_worktree ?? false,
  });
}

/** Sets up a session with no sessionState -- fields like cwd, model, git_branch will be null/empty. */
function setupBareSession(): void {
  store().ensureSessionData(SESSION);
  useStore.setState({
    currentSessionId: SESSION,
    sessions: {
      [SESSION]: makeSessionInfo({ sessionId: SESSION, adapterType: "claude" }),
    },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("StatusBar", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  // ── Layout ──────────────────────────────────────────────────────────────────

  describe("layout", () => {
    it("always renders a <footer> element", () => {
      render(<StatusBar />);
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    });

    it("renders adapter label when session is active", () => {
      setupSession({ adapterType: "claude" });
      render(<StatusBar />);
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });

    it("renders cwd basename", () => {
      setupSession({ cwd: "/home/user/my-project" });
      render(<StatusBar />);
      expect(screen.getByText("my-project")).toBeInTheDocument();
    });

    it("renders em dash when cwd is not set", () => {
      setupBareSession();
      render(<StatusBar />);
      const dashes = screen.getAllByText("\u2014");
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── AdapterSelector ─────────────────────────────────────────────────────────

  describe("AdapterSelector", () => {
    it("renders the adapter label for the current type", () => {
      setupSession({ adapterType: "gemini" });
      render(<StatusBar />);
      expect(screen.getByText("Gemini")).toBeInTheDocument();
    });

    it("renders adapter badge as static text", () => {
      setupSession({ adapterType: "codex" });
      render(<StatusBar />);
      expect(screen.getByText("Codex")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /codex/i })).not.toBeInTheDocument();
    });

    it("renders static badge for all adapter types", () => {
      for (const [type, label] of [
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["claude", "Claude Code"],
        ["acp", "ACP"],
      ] as const) {
        resetStore();
        setupSession({ adapterType: type });
        const { unmount } = render(<StatusBar />);
        expect(screen.getByText(label)).toBeInTheDocument();
        unmount();
      }
    });
  });

  // ── LogsButton ──────────────────────────────────────────────────────────────

  describe("LogsButton", () => {
    it("does not render when no process logs exist", () => {
      setupSession();
      render(<StatusBar />);
      expect(screen.queryByLabelText("Toggle process logs")).not.toBeInTheDocument();
    });

    it("renders when processLogs has entries", () => {
      setupSession();
      store().appendProcessLog(SESSION, "test log line");
      render(<StatusBar />);
      expect(screen.getByLabelText("Toggle process logs")).toBeInTheDocument();
    });

    it("toggles logDrawerOpen when clicked", async () => {
      const user = userEvent.setup();
      setupSession();
      store().appendProcessLog(SESSION, "log entry");
      render(<StatusBar />);

      expect(useStore.getState().logDrawerOpen).toBe(false);
      await user.click(screen.getByLabelText("Toggle process logs"));
      expect(useStore.getState().logDrawerOpen).toBe(true);

      await user.click(screen.getByLabelText("Toggle process logs"));
      expect(useStore.getState().logDrawerOpen).toBe(false);
    });
  });

  // ── Git Status ──────────────────────────────────────────────────────────────

  describe("git status", () => {
    it("renders branch name", () => {
      setupSession({ git_branch: "feat/cool-feature" });
      render(<StatusBar />);
      expect(screen.getByText("feat/cool-feature")).toBeInTheDocument();
    });

    it("renders em dash when no git branch", () => {
      setupBareSession();
      render(<StatusBar />);
      const dashes = screen.getAllByText("\u2014");
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });

    it("shows ahead indicator when git_ahead > 0", () => {
      setupSession({ git_ahead: 3 });
      render(<StatusBar />);
      expect(screen.getByText("\u21913")).toBeInTheDocument();
    });

    it("shows behind indicator when git_behind > 0", () => {
      setupSession({ git_behind: 2 });
      render(<StatusBar />);
      expect(screen.getByText("\u21932")).toBeInTheDocument();
    });

    it("shows both ahead and behind indicators", () => {
      setupSession({ git_ahead: 5, git_behind: 1 });
      render(<StatusBar />);
      expect(screen.getByText("\u21915")).toBeInTheDocument();
      expect(screen.getByText("\u21931")).toBeInTheDocument();
    });

    it("does not show indicators when both are 0", () => {
      setupSession({ git_ahead: 0, git_behind: 0 });
      render(<StatusBar />);
      expect(screen.queryByText("\u2191")).not.toBeInTheDocument();
      expect(screen.queryByText("\u2193")).not.toBeInTheDocument();
    });

    it("renders worktree badge when is_worktree is true", () => {
      setupSession({ is_worktree: true });
      render(<StatusBar />);
      expect(screen.getByText("Worktree")).toBeInTheDocument();
    });

    it("does not render worktree badge when is_worktree is false", () => {
      setupSession({ is_worktree: false });
      render(<StatusBar />);
      expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
    });
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  describe("accessibility", () => {
    it("has no axe violations with active session", async () => {
      setupSession();
      render(<StatusBar />);
      const results = await checkA11y();
      expect(results).toHaveNoViolations();
    });
  });
});
