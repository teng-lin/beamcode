import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { makePermission, resetStore, store } from "../test/factories";
import { TopBar } from "./TopBar";

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
});
