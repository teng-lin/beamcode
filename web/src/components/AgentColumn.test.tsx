import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { makeAssistantMessage, resetStore } from "../test/factories";
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

function agentMsg(id: string) {
  const msg = makeAssistantMessage(AGENT_ID, id);
  return msg;
}

describe("AgentColumn", () => {
  beforeEach(() => {
    resetStore({ currentSessionId: SESSION });
    useStore.getState().ensureSessionData(SESSION);
  });

  it("renders agent name and type in header", () => {
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        messages={[]}
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("researcher")).toBeInTheDocument();
    expect(screen.getByText("general-purpose")).toBeInTheDocument();
  });

  it("shows waiting state when no messages", () => {
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        messages={[]}
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("Waiting...")).toBeInTheDocument();
  });

  it("renders passed messages", () => {
    const messages = [agentMsg("msg-a1"), agentMsg("msg-a2")];
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        messages={messages}
        sessionId={SESSION}
      />,
    );
    expect(screen.getByTestId("msg-msg-a1")).toBeInTheDocument();
    expect(screen.getByTestId("msg-msg-a2")).toBeInTheDocument();
  });

  it("renders status dot with correct class for idle status", () => {
    const { container } = render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="idle"
        messages={[]}
        sessionId={SESSION}
      />,
    );
    const dot = container.querySelector("span.rounded-full");
    expect(dot?.className).toContain("bg-bc-warning");
  });

  it("shows streaming indicator when agent is streaming", () => {
    useStore.getState().initAgentStreaming(SESSION, AGENT_ID);
    useStore.getState().appendAgentStreaming(SESSION, AGENT_ID, "Streaming...");

    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type="general-purpose"
        status="active"
        messages={[]}
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("omits type badge when type is empty", () => {
    render(
      <AgentColumn
        agentId={AGENT_ID}
        name="researcher"
        type=""
        status="active"
        messages={[]}
        sessionId={SESSION}
      />,
    );
    expect(screen.getByText("researcher")).toBeInTheDocument();
    const header = screen.getByText("researcher").parentElement;
    expect(header?.querySelectorAll("span")).toHaveLength(2); // dot + name
  });
});
