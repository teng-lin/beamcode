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

const { send } = (await import("../ws")) as unknown as { send: ReturnType<typeof vi.fn> };

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

type ModelEntry = { value: string; displayName: string };

/** Shorthand for setCapabilities with only model entries (commands and skills default to []). */
function setModels(...models: ModelEntry[]): void {
  store().setCapabilities(SESSION, { commands: [], models, skills: [] });
}

/** Opens the permission-mode dropdown and clicks the Auto-Approve option. */
async function clickBypassOption(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText("Default"));
  const buttons = screen.getAllByRole("button");
  const bypassButton = buttons.find(
    (b) =>
      b.textContent?.includes("Auto-Approve") &&
      b.textContent?.includes("Auto-approve all tool executions"),
  );
  expect(bypassButton).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: test helper - bypassButton verified above
  await user.click(bypassButton!);
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

    it('shows "No session" when no active session', () => {
      render(<StatusBar />);
      expect(screen.getByText("No session")).toBeInTheDocument();
    });

    it("renders adapter label when session is active", () => {
      setupSession({ adapterType: "claude" });
      render(<StatusBar />);
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
      expect(screen.queryByText("No session")).not.toBeInTheDocument();
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

    it("opens dropdown with all adapter options on click", async () => {
      const user = userEvent.setup();
      setupSession({ adapterType: "claude" });
      render(<StatusBar />);

      await user.click(screen.getByText("Claude Code"));
      expect(screen.getByText("Codex")).toBeInTheDocument();
      expect(screen.getByText("Continue")).toBeInTheDocument();
      expect(screen.getByText("Gemini")).toBeInTheDocument();
    });

    it("sends set_adapter message and closes dropdown on selection", async () => {
      const user = userEvent.setup();
      setupSession({ adapterType: "claude" });
      render(<StatusBar />);

      await user.click(screen.getByText("Claude Code"));
      await user.click(screen.getByText("Codex"));

      expect(send).toHaveBeenCalledWith({ type: "set_adapter", adapter: "codex" }, SESSION);
      expect(screen.queryByText("Continue")).not.toBeInTheDocument();
    });

    it("closes dropdown on Escape key", async () => {
      const user = userEvent.setup();
      setupSession({ adapterType: "claude" });
      render(<StatusBar />);

      await user.click(screen.getByText("Claude Code"));
      expect(screen.getByText("Codex")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    });

    it("shows static badge (not a dropdown button) when observer", () => {
      setupSession({ adapterType: "claude" });
      store().setIdentity(SESSION, { userId: "u1", displayName: "Bob", role: "observer" });
      render(<StatusBar />);

      const label = screen.getByText("Claude Code");
      expect(label.tagName).toBe("SPAN");
      expect(label.closest("button")).toBeNull();
    });
  });

  // ── PermissionModePicker ────────────────────────────────────────────────────

  describe("PermissionModePicker", () => {
    it("renders the current permission mode label", () => {
      setupSession({ permissionMode: "default" });
      render(<StatusBar />);
      expect(screen.getByText("Default")).toBeInTheDocument();
    });

    it("renders Plan mode label", () => {
      setupSession({ permissionMode: "plan" });
      render(<StatusBar />);
      expect(screen.getByText("Plan")).toBeInTheDocument();
    });

    it("renders Auto-Approve mode label", () => {
      setupSession({ permissionMode: "bypassPermissions" });
      render(<StatusBar />);
      expect(screen.getByText("Auto-Approve")).toBeInTheDocument();
    });

    it("opens dropdown with all mode options on click", async () => {
      const user = userEvent.setup();
      setupSession({ permissionMode: "default" });
      render(<StatusBar />);

      await user.click(screen.getByText("Default"));
      expect(screen.getByText("Plan")).toBeInTheDocument();
      expect(screen.getByText("Auto-Approve")).toBeInTheDocument();
      expect(screen.getByText("Ask before risky actions")).toBeInTheDocument();
      expect(screen.getByText("Require plan approval first")).toBeInTheDocument();
    });

    it("sends set_permission_mode on selecting a normal mode", async () => {
      const user = userEvent.setup();
      setupSession({ permissionMode: "default" });
      render(<StatusBar />);

      await user.click(screen.getByText("Default"));
      const dropdownButtons = screen.getAllByRole("button");
      const planButton = dropdownButtons.find(
        (b) => b.textContent?.includes("Plan") && b.textContent?.includes("Require plan approval"),
      );
      expect(planButton).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: test helper - planButton verified above
      await user.click(planButton!);

      expect(send).toHaveBeenCalledWith({ type: "set_permission_mode", mode: "plan" }, SESSION);
    });

    it("shows confirmation dialog when selecting bypass mode", async () => {
      const user = userEvent.setup();
      setupSession({ permissionMode: "default" });
      render(<StatusBar />);

      await clickBypassOption(user);

      expect(screen.getByText("Enable Auto-Approve?")).toBeInTheDocument();
      expect(screen.getByText("Enable")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    it("confirms bypass sends set_permission_mode and closes dialog", async () => {
      const user = userEvent.setup();
      setupSession({ permissionMode: "default" });
      render(<StatusBar />);

      await clickBypassOption(user);
      await user.click(screen.getByText("Enable"));

      expect(send).toHaveBeenCalledWith(
        { type: "set_permission_mode", mode: "bypassPermissions" },
        SESSION,
      );
      expect(screen.queryByText("Enable Auto-Approve?")).not.toBeInTheDocument();
    });

    it("cancels bypass confirmation dialog without sending", async () => {
      const user = userEvent.setup();
      setupSession({ permissionMode: "default" });
      render(<StatusBar />);

      await clickBypassOption(user);
      await user.click(screen.getByText("Cancel"));

      expect(send).not.toHaveBeenCalled();
      expect(screen.queryByText("Enable Auto-Approve?")).not.toBeInTheDocument();
    });

    it("returns null when no permissionMode in state", () => {
      setupBareSession();
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-sonnet-4-20250514",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
      });
      render(<StatusBar />);
      expect(screen.queryByText("Default")).not.toBeInTheDocument();
      expect(screen.queryByText("Plan")).not.toBeInTheDocument();
      expect(screen.queryByText("Auto-Approve")).not.toBeInTheDocument();
    });

    it("is disabled when user is observer", async () => {
      const user = userEvent.setup();
      setupSession({ permissionMode: "default" });
      store().setIdentity(SESSION, { userId: "u1", displayName: "Bob", role: "observer" });
      render(<StatusBar />);

      // biome-ignore lint/style/noNonNullAssertion: test helper - closest always returns for this selector
      const defaultButton = screen.getByText("Default").closest("button")!;
      expect(defaultButton).toBeDisabled();

      await user.click(defaultButton);
      expect(screen.queryByText("Ask before risky actions")).not.toBeInTheDocument();
    });
  });

  // ── ModelPicker ─────────────────────────────────────────────────────────────

  describe("ModelPicker", () => {
    it("abbreviates model name to Sonnet", () => {
      setupSession({ model: "claude-sonnet-4-20250514" });
      setModels({ value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" });
      render(<StatusBar />);
      expect(screen.getByText("Sonnet")).toBeInTheDocument();
    });

    it("abbreviates model name to Opus", () => {
      setupSession({ model: "claude-opus-4-20250514" });
      setModels({ value: "claude-opus-4-20250514", displayName: "Claude Opus 4" });
      render(<StatusBar />);
      expect(screen.getByText("Opus")).toBeInTheDocument();
    });

    it("abbreviates model name to Haiku", () => {
      setupSession({ model: "claude-haiku-4-20250514" });
      setModels({ value: "claude-haiku-4-20250514", displayName: "Claude Haiku 4" });
      render(<StatusBar />);
      expect(screen.getByText("Haiku")).toBeInTheDocument();
    });

    it("opens dropdown when 2+ models are available", async () => {
      const user = userEvent.setup();
      setupSession({ model: "claude-sonnet-4-20250514" });
      setModels(
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      );
      render(<StatusBar />);

      await user.click(screen.getByText("Sonnet"));
      expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
      expect(screen.getByText("Claude Sonnet 4")).toBeInTheDocument();
    });

    it("sends set_model message and closes dropdown on selection", async () => {
      const user = userEvent.setup();
      setupSession({ model: "claude-sonnet-4-20250514" });
      setModels(
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      );
      render(<StatusBar />);

      await user.click(screen.getByText("Sonnet"));
      await user.click(screen.getByText("Claude Opus 4"));

      expect(send).toHaveBeenCalledWith(
        { type: "set_model", model: "claude-opus-4-20250514" },
        SESSION,
      );
      expect(screen.queryByText("Claude Opus 4")).not.toBeInTheDocument();
    });

    it("is not clickable when only 1 model", () => {
      setupSession({ model: "claude-sonnet-4-20250514" });
      setModels({ value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" });
      render(<StatusBar />);

      // biome-ignore lint/style/noNonNullAssertion: test helper - closest always returns for this selector
      const button = screen.getByText("Sonnet").closest("button")!;
      expect(button).toBeDisabled();
    });

    it("is disabled when user is observer", () => {
      setupSession({ model: "claude-sonnet-4-20250514" });
      store().setIdentity(SESSION, { userId: "u1", displayName: "Bob", role: "observer" });
      setModels(
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      );
      render(<StatusBar />);

      // biome-ignore lint/style/noNonNullAssertion: test helper - closest always returns for this selector
      const button = screen.getByText("Sonnet").closest("button")!;
      expect(button).toBeDisabled();
    });

    it("returns null when model is empty", () => {
      setupBareSession();
      render(<StatusBar />);
      expect(screen.queryByText("Sonnet")).not.toBeInTheDocument();
      expect(screen.queryByText("Opus")).not.toBeInTheDocument();
      expect(screen.queryByText("Haiku")).not.toBeInTheDocument();
    });

    it("uses displayName directly for non-Anthropic models", () => {
      setupSession({ model: "gpt-4o" });
      setModels({ value: "gpt-4o", displayName: "GPT-4o" });
      render(<StatusBar />);
      expect(screen.getByText("GPT-4o")).toBeInTheDocument();
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
