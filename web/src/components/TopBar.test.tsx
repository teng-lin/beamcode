import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { makePermission, resetStore, store } from "../test/factories";
import { TopBar } from "./TopBar";

vi.mock("../ws", () => ({
  send: vi.fn(),
}));

const { send } = (await import("../ws")) as unknown as { send: ReturnType<typeof vi.fn> };

const SESSION = "topbar-test";

function setupSession(
  options?: Partial<{
    connectionStatus: "connected" | "connecting" | "disconnected";
    model: string;
    permissionCount: number;
  }>,
): void {
  store().ensureSessionData(SESSION);
  useStore.setState({ currentSessionId: SESSION });

  if (options?.connectionStatus) {
    store().setConnectionStatus(SESSION, options.connectionStatus);
  }
  if (options?.model) {
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: options.model,
      cwd: "/tmp",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
    });
  }
  if (options?.permissionCount) {
    for (let i = 1; i <= options.permissionCount; i++) {
      store().addPermission(SESSION, makePermission({ request_id: `req-${i}` }));
    }
  }
}

describe("TopBar", () => {
  beforeEach(() => {
    resetStore({ sidebarOpen: true, taskPanelOpen: false });
    vi.clearAllMocks();
  });

  it("renders connection status text", () => {
    setupSession({ connectionStatus: "connecting" });
    render(<TopBar />);
    expect(screen.getByText("connecting")).toBeInTheDocument();
  });

  it('shows "connected" status with success styling', () => {
    setupSession({ connectionStatus: "connected" });
    render(<TopBar />);
    expect(screen.getByText("connected")).toBeInTheDocument();
  });

  it('shows "disconnected" status', () => {
    render(<TopBar />);
    expect(screen.getByText("disconnected")).toBeInTheDocument();
  });

  it("renders model badge when model is set", () => {
    setupSession({ model: "claude-sonnet-4-20250514" });
    render(<TopBar />);
    expect(screen.getByText("claude-sonnet-4-20250514")).toBeInTheDocument();
  });

  it("does not render model badge when no model", () => {
    setupSession({ connectionStatus: "connected" });
    render(<TopBar />);
    expect(screen.queryByText(/claude/)).not.toBeInTheDocument();
  });

  it("renders pending permissions count badge when > 0", () => {
    setupSession({ connectionStatus: "connected", permissionCount: 2 });
    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("does not render badge when count is 0", () => {
    setupSession({ connectionStatus: "connected" });
    render(<TopBar />);
    const badges = screen.queryByText(/^\d+$/);
    expect(badges).not.toBeInTheDocument();
  });

  it("sidebar toggle button has correct aria-label based on sidebarOpen state", () => {
    setupSession();
    const { unmount } = render(<TopBar />);
    expect(screen.getByLabelText("Close sidebar")).toBeInTheDocument();
    unmount();

    useStore.setState({ sidebarOpen: false });
    render(<TopBar />);
    expect(screen.getByLabelText("Open sidebar")).toBeInTheDocument();
  });

  it("clicking sidebar toggle calls toggleSidebar", async () => {
    const user = userEvent.setup();
    setupSession();
    render(<TopBar />);

    expect(useStore.getState().sidebarOpen).toBe(true);
    await user.click(screen.getByLabelText("Close sidebar"));
    expect(useStore.getState().sidebarOpen).toBe(false);
  });

  it("clicking task panel toggle button works", async () => {
    const user = userEvent.setup();
    setupSession();
    render(<TopBar />);

    expect(useStore.getState().taskPanelOpen).toBe(false);
    await user.click(screen.getByLabelText("Toggle task panel"));
    expect(useStore.getState().taskPanelOpen).toBe(true);
  });

  it("model badge opens dropdown on click when models available", async () => {
    const user = userEvent.setup();
    setupSession({ model: "claude-sonnet-4-20250514" });
    store().setCapabilities(SESSION, {
      commands: [],
      models: [
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      ],
    });
    render(<TopBar />);

    await user.click(screen.getByText("claude-sonnet-4-20250514"));
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
  });

  it("selecting a model sends set_model message and closes dropdown", async () => {
    const user = userEvent.setup();
    setupSession({ model: "claude-sonnet-4-20250514" });
    store().setCapabilities(SESSION, {
      commands: [],
      models: [
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      ],
    });
    render(<TopBar />);

    await user.click(screen.getByText("claude-sonnet-4-20250514"));
    await user.click(screen.getByText("Claude Opus 4"));

    expect(send).toHaveBeenCalledWith({ type: "set_model", model: "claude-opus-4-20250514" });
    expect(screen.queryByText("Claude Opus 4")).not.toBeInTheDocument();
  });

  it("model badge is not clickable when no capabilities", () => {
    setupSession({ model: "claude-sonnet-4-20250514" });
    render(<TopBar />);

    const modelText = screen.getByText("claude-sonnet-4-20250514");
    expect(modelText.closest("button")).toBeNull();
  });

  it("closes dropdown when clicking outside", async () => {
    const user = userEvent.setup();
    setupSession({ model: "claude-sonnet-4-20250514" });
    store().setCapabilities(SESSION, {
      commands: [],
      models: [
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      ],
    });
    render(<TopBar />);

    // Open dropdown
    await user.click(screen.getByText("claude-sonnet-4-20250514"));
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();

    // Click outside (sidebar toggle button)
    await user.click(screen.getByLabelText("Close sidebar"));
    expect(screen.queryByText("Claude Opus 4")).not.toBeInTheDocument();
  });

  it("closes dropdown when Escape is pressed", async () => {
    const user = userEvent.setup();
    setupSession({ model: "claude-sonnet-4-20250514" });
    store().setCapabilities(SESSION, {
      commands: [],
      models: [
        { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
        { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      ],
    });
    render(<TopBar />);

    await user.click(screen.getByText("claude-sonnet-4-20250514"));
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("Claude Opus 4")).not.toBeInTheDocument();
  });

  it("renders git branch when available", () => {
    setupSession({ model: "claude-sonnet-4-20250514" });
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "feat/cool-feature",
    });
    render(<TopBar />);
    expect(screen.getByText("feat/cool-feature")).toBeInTheDocument();
  });

  it("does not render git branch when not available", () => {
    setupSession({ model: "claude-sonnet-4-20250514" });
    render(<TopBar />);
    expect(screen.queryByLabelText("Git branch")).not.toBeInTheDocument();
  });
});
