import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkSessionInfo } from "../store";
import { useStore } from "../store";
import { makeSessionInfo } from "../test/factories";
import { Sidebar } from "./Sidebar";

vi.mock("../api", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  disconnect: vi.fn(),
}));

function setupSessions(...sessions: SdkSessionInfo[]) {
  const map: Record<string, SdkSessionInfo> = {};
  for (const s of sessions) map[s.sessionId] = s;
  useStore.setState({ sessions: map });
}

describe("Sidebar", () => {
  beforeEach(() => {
    useStore.setState({
      sessionData: {},
      sessions: {},
      currentSessionId: null,
    });
    vi.clearAllMocks();
  });

  it('renders "BeamCode" branding', () => {
    render(<Sidebar />);
    expect(screen.getByText("BeamCode")).toBeInTheDocument();
  });

  it('renders "No sessions" when list is empty', () => {
    render(<Sidebar />);
    expect(screen.getByText("No sessions")).toBeInTheDocument();
  });

  it("renders session items from store", () => {
    setupSessions(
      makeSessionInfo({ sessionId: "s1", cwd: "/home/user/project-alpha", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", cwd: "/home/user/project-beta", createdAt: 2000 }),
    );
    render(<Sidebar />);

    expect(screen.getByText("project-alpha")).toBeInTheDocument();
    expect(screen.getByText("project-beta")).toBeInTheDocument();
  });

  it("highlights active session with aria-current", () => {
    setupSessions(
      makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
    );
    useStore.setState({ currentSessionId: "s1" });
    render(<Sidebar />);

    const activeItem = screen.getByText("alpha").closest("[role=button]");
    expect(activeItem).toHaveAttribute("aria-current", "page");

    const inactiveItem = screen.getByText("beta").closest("[role=button]");
    expect(inactiveItem).not.toHaveAttribute("aria-current");
  });

  it('renders "New" button', () => {
    render(<Sidebar />);
    expect(screen.getByLabelText("New session")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("renders session names (derived from cwd basename)", () => {
    setupSessions(
      makeSessionInfo({
        sessionId: "s1",
        cwd: "/Users/dev/workspace/my-cool-project",
        createdAt: 1000,
      }),
    );
    render(<Sidebar />);

    expect(screen.getByText("my-cool-project")).toBeInTheDocument();
  });
});
