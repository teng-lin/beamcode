import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import {
  makeAssistantContent,
  makeAssistantMessage,
  makeToolUseBlock,
  resetStore,
} from "../test/factories";
import { AgentColumn } from "./AgentColumn";

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ message }: { message: { message: { id: string } } }) => (
    <div data-testid={`msg-${message.message.id}`}>msg</div>
  ),
}));
vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

const SESSION = "col-test";
const AGENT_ID = "tu-col-1";

function setupSession() {
  useStore.getState().ensureSessionData(SESSION);
  useStore.getState().addMessage(SESSION, {
    type: "assistant",
    parent_tool_use_id: null,
    message: makeAssistantContent([
      makeToolUseBlock({
        id: AGENT_ID,
        name: "Task",
        input: { name: "researcher", subagent_type: "general-purpose" },
      }),
    ]),
  });
}

describe("AgentColumn", () => {
  beforeEach(() => {
    resetStore({ currentSessionId: SESSION });
  });

  it("renders agent name and type in header", () => {
    setupSession();
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("researcher")).toBeInTheDocument();
    expect(screen.getByText("general-purpose")).toBeInTheDocument();
  });

  it("shows waiting state when no messages", () => {
    setupSession();
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("Waiting...")).toBeInTheDocument();
  });

  it("renders filtered agent messages", () => {
    setupSession();
    useStore.getState().addMessage(SESSION, makeAssistantMessage(AGENT_ID, "msg-a1"));
    useStore.getState().addMessage(SESSION, makeAssistantMessage("tu-other", "msg-other"));
    useStore.getState().addMessage(SESSION, makeAssistantMessage(AGENT_ID, "msg-a2"));

    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        sessionId={SESSION}
      />,
    );
    expect(screen.getByTestId("msg-msg-a1")).toBeInTheDocument();
    expect(screen.getByTestId("msg-msg-a2")).toBeInTheDocument();
    expect(screen.queryByTestId("msg-msg-other")).not.toBeInTheDocument();
  });

  it("renders status dot with correct class for idle status", () => {
    setupSession();
    const { container } = render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="idle"
        sessionId={SESSION}
      />,
    );
    const dot = container.querySelector("span.rounded-full");
    expect(dot?.className).toContain("bg-bc-warning");
  });

  it("shows streaming indicator when agent is streaming", () => {
    setupSession();
    useStore.getState().initAgentStreaming(SESSION, AGENT_ID);
    useStore.getState().appendAgentStreaming(SESSION, AGENT_ID, "Streaming...");

    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("omits type badge when type is empty", () => {
    setupSession();
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type=""
        status="active"
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("researcher")).toBeInTheDocument();
    // Only the name should be in the header, no type span
    const header = screen.getByText("researcher").parentElement;
    expect(header?.querySelectorAll("span")).toHaveLength(2); // dot + name
  });
});
