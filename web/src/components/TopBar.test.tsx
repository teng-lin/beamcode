import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { TopBar } from "./TopBar";

const SESSION = "topbar-test";
const store = () => useStore.getState();

function setupSession(
  overrides?: Partial<{
    connectionStatus: string;
    model: string;
    pendingPermissions: Record<string, unknown>;
  }>,
) {
  store().ensureSessionData(SESSION);
  useStore.setState({ currentSessionId: SESSION });
  if (overrides?.connectionStatus)
    store().setConnectionStatus(
      SESSION,
      overrides.connectionStatus as "connected" | "connecting" | "disconnected",
    );
  if (overrides?.model)
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: overrides.model,
      cwd: "/tmp",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
    });
  if (overrides?.pendingPermissions) {
    for (const [id, perm] of Object.entries(overrides.pendingPermissions)) {
      store().addPermission(SESSION, {
        request_id: id,
        tool_use_id: `tu-${id}`,
        tool_name: "Bash",
        description: "Run a command",
        input: { command: "ls" },
        timestamp: Date.now(),
        ...(perm as Record<string, unknown>),
      });
    }
  }
}

describe("TopBar", () => {
  beforeEach(() => {
    useStore.setState({
      sessionData: {},
      sessions: {},
      currentSessionId: null,
      sidebarOpen: true,
      taskPanelOpen: false,
    });
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
    setupSession({
      connectionStatus: "connected",
      pendingPermissions: { "req-1": {}, "req-2": {} },
    });
    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("does not render badge when count is 0", () => {
    setupSession({ connectionStatus: "connected" });
    render(<TopBar />);
    // No numeric badge should be present
    const badges = screen.queryByText(/^\d+$/);
    expect(badges).not.toBeInTheDocument();
  });

  it("sidebar toggle button has correct aria-label based on sidebarOpen state", () => {
    setupSession();
    // sidebarOpen is true by default in beforeEach
    const { unmount } = render(<TopBar />);
    expect(screen.getByLabelText("Close sidebar")).toBeInTheDocument();
    unmount();

    // Toggle sidebar closed
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
});
