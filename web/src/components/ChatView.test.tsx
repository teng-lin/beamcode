import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { ChatView } from "./ChatView";

vi.mock("./EmptyState", () => ({ EmptyState: () => <div data-testid="empty-state" /> }));
vi.mock("./MessageFeed", () => ({ MessageFeed: () => <div data-testid="message-feed" /> }));
vi.mock("./Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("./ConnectionBanner", () => ({
  ConnectionBanner: () => <div data-testid="connection-banner" />,
}));
vi.mock("./PermissionBanner", () => ({
  PermissionBanner: () => <div data-testid="permission-banner" />,
}));
vi.mock("./StreamingIndicator", () => ({
  StreamingIndicator: () => <div data-testid="streaming-indicator" />,
}));

const SESSION = "chatview-test";
const store = () => useStore.getState();

describe("ChatView", () => {
  beforeEach(() => {
    useStore.setState({
      sessionData: {},
      sessions: {},
      currentSessionId: null,
    });
  });

  it("renders EmptyState when no currentSessionId", () => {
    render(<ChatView />);
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("renders EmptyState when no session data", () => {
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("renders EmptyState when session has no messages", () => {
    store().ensureSessionData(SESSION);
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("renders MessageFeed when session has messages", () => {
    store().ensureSessionData(SESSION);
    store().addMessage(SESSION, {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("message-feed")).toBeInTheDocument();
  });

  it("renders Composer", () => {
    store().ensureSessionData(SESSION);
    store().addMessage(SESSION, {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("composer")).toBeInTheDocument();
  });

  it("renders ConnectionBanner when CLI disconnected but WebSocket connected", () => {
    store().ensureSessionData(SESSION);
    store().setConnectionStatus(SESSION, "connected");
    store().setCliConnected(SESSION, false);
    store().addMessage(SESSION, {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("connection-banner")).toBeInTheDocument();
  });

  it("does not render ConnectionBanner when CLI is connected", () => {
    store().ensureSessionData(SESSION);
    store().setConnectionStatus(SESSION, "connected");
    store().setCliConnected(SESSION, true);
    store().addMessage(SESSION, {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.queryByTestId("connection-banner")).not.toBeInTheDocument();
  });

  it("renders PermissionBanner when permissions pending", () => {
    store().ensureSessionData(SESSION);
    store().addPermission(SESSION, {
      request_id: "perm-1",
      tool_use_id: "tu-1",
      tool_name: "Bash",
      description: "Run a command",
      input: { command: "ls" },
      timestamp: Date.now(),
    });
    store().addMessage(SESSION, {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("permission-banner")).toBeInTheDocument();
  });
});
