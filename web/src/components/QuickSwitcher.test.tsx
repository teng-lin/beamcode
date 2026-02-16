import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { makeSessionInfo, resetStore } from "../test/factories";
import { QuickSwitcher } from "./QuickSwitcher";

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  disconnect: vi.fn(),
}));

import { connectToSession } from "../ws";

function setupSessions() {
  const sessions: Record<string, ReturnType<typeof makeSessionInfo>> = {};
  const s1 = makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 });
  const s2 = makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 });
  const s3 = makeSessionInfo({
    sessionId: "s3",
    name: "My Project",
    cwd: "/home/user/gamma",
    createdAt: 3000,
  });
  sessions[s1.sessionId] = s1;
  sessions[s2.sessionId] = s2;
  sessions[s3.sessionId] = s3;
  useStore.setState({ sessions, currentSessionId: "s1" });
}

describe("QuickSwitcher", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("renders search input focused on mount", () => {
    setupSessions();
    render(<QuickSwitcher onClose={() => {}} />);
    expect(screen.getByPlaceholderText("Switch session...")).toHaveFocus();
  });

  it("shows all sessions initially sorted by recency", () => {
    setupSessions();
    render(<QuickSwitcher onClose={() => {}} />);
    expect(screen.getByText("My Project")).toBeInTheDocument();
    // Sessions without a name show cwd basename in both name and hint spans
    expect(screen.getAllByText("beta").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("alpha").length).toBeGreaterThanOrEqual(1);
  });

  it("filters sessions by typing", async () => {
    const user = userEvent.setup();
    setupSessions();
    render(<QuickSwitcher onClose={() => {}} />);

    await user.type(screen.getByPlaceholderText("Switch session..."), "alpha");
    expect(screen.getAllByText("alpha").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
  });

  it("selects session on Enter and calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setupSessions();
    render(<QuickSwitcher onClose={onClose} />);

    // First item is "My Project" (most recent, createdAt: 3000)
    await user.keyboard("{Enter}");
    expect(useStore.getState().currentSessionId).toBe("s3");
    expect(connectToSession).toHaveBeenCalledWith("s3");
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates items with arrow keys", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setupSessions();
    render(<QuickSwitcher onClose={onClose} />);

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    // Should select second item (beta, createdAt: 2000)
    expect(useStore.getState().currentSessionId).toBe("s2");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setupSessions();
    render(<QuickSwitcher onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    setupSessions();
    render(<QuickSwitcher onClose={onClose} />);

    await user.click(screen.getByTestId("quick-switcher-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });
});
