import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import {
  makeAssistantContent,
  makePermission,
  makeToolUseBlock,
  resetStore,
  store,
} from "../test/factories";
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
vi.mock("./AgentGridView", () => ({
  AgentGridView: () => <div data-testid="agent-grid-view" />,
}));

const SESSION = "chatview-test";

function addUserMessage(): void {
  store().addMessage(SESSION, {
    type: "user_message",
    content: "hello",
    timestamp: Date.now(),
  });
}

function setupSessionWithMessage(): void {
  store().ensureSessionData(SESSION);
  addUserMessage();
  useStore.setState({ currentSessionId: SESSION });
}

function addTaskToolUse(id: string, name: string): void {
  store().addMessage(SESSION, {
    type: "assistant",
    parent_tool_use_id: null,
    message: makeAssistantContent([
      makeToolUseBlock({
        id,
        name: "Task",
        input: { name, subagent_type: "general-purpose" },
      }),
    ]),
  });
}

describe("ChatView", () => {
  beforeEach(() => {
    resetStore();
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
    setupSessionWithMessage();
    render(<ChatView />);
    expect(screen.getByTestId("message-feed")).toBeInTheDocument();
  });

  it("renders Composer", () => {
    setupSessionWithMessage();
    render(<ChatView />);
    expect(screen.getByTestId("composer")).toBeInTheDocument();
  });

  it("renders ConnectionBanner when CLI disconnected but WebSocket connected", () => {
    store().ensureSessionData(SESSION);
    store().setConnectionStatus(SESSION, "connected");
    store().setCliConnected(SESSION, false);
    addUserMessage();
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("connection-banner")).toBeInTheDocument();
  });

  it("does not render ConnectionBanner when CLI is connected", () => {
    store().ensureSessionData(SESSION);
    store().setConnectionStatus(SESSION, "connected");
    store().setCliConnected(SESSION, true);
    addUserMessage();
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.queryByTestId("connection-banner")).not.toBeInTheDocument();
  });

  it("renders PermissionBanner when permissions pending", () => {
    store().ensureSessionData(SESSION);
    store().addPermission(SESSION, makePermission());
    addUserMessage();
    useStore.setState({ currentSessionId: SESSION });
    render(<ChatView />);
    expect(screen.getByTestId("permission-banner")).toBeInTheDocument();
  });

  it("renders AgentGridView when session has Task tool_use blocks", () => {
    setupSessionWithMessage();
    addTaskToolUse("tu-1", "researcher");
    render(<ChatView />);
    expect(screen.getByTestId("agent-grid-view")).toBeInTheDocument();
  });

  it("does not render AgentGridView when no agents", () => {
    setupSessionWithMessage();
    render(<ChatView />);
    expect(screen.queryByTestId("agent-grid-view")).not.toBeInTheDocument();
  });
});
