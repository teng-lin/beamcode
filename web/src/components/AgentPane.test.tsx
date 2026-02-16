import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import {
  makeAssistantContent,
  makeAssistantMessage,
  makeTeamMember,
  makeToolUseBlock,
  resetStore,
} from "../test/factories";
import { AgentPane } from "./AgentPane";

const SESSION = "pane-test";
const AGENT_ID = "tu-agent-1";

function setupSession() {
  useStore.getState().ensureSessionData(SESSION);
  // Add a main assistant message that contains the Task tool_use block
  useStore.getState().addMessage(SESSION, {
    type: "assistant",
    parent_tool_use_id: null,
    message: makeAssistantContent([
      makeToolUseBlock({
        id: AGENT_ID,
        name: "Task",
        input: { name: "researcher", subagent_type: "general-purpose", description: "Research" },
      }),
    ]),
  });
}

describe("AgentPane", () => {
  beforeEach(() => {
    resetStore({ currentSessionId: SESSION });
  });

  it("renders agent name from tool_use block", () => {
    setupSession();
    render(<AgentPane agentId={AGENT_ID} sessionId={SESSION} onClose={() => {}} />);
    expect(screen.getByText("researcher")).toBeInTheDocument();
    expect(screen.getByText("general-purpose")).toBeInTheDocument();
  });

  it("shows empty state when no agent messages", () => {
    setupSession();
    render(<AgentPane agentId={AGENT_ID} sessionId={SESSION} onClose={() => {}} />);
    expect(screen.getByText("Waiting for agent output...")).toBeInTheDocument();
  });

  it("renders agent messages filtered by agentId", () => {
    setupSession();
    // Add an agent message for our agent
    useStore.getState().addMessage(SESSION, makeAssistantMessage(AGENT_ID, "msg-agent-1"));
    // Add an agent message for a different agent
    useStore.getState().addMessage(SESSION, makeAssistantMessage("tu-other", "msg-other"));

    render(<AgentPane agentId={AGENT_ID} sessionId={SESSION} onClose={() => {}} />);
    // "Hello" comes from makeAssistantMessage which creates text content "Hello"
    // There should be exactly one "Hello" visible (the one for our agent)
    const hellos = screen.getAllByText("Hello");
    expect(hellos).toHaveLength(1);
  });

  it("close button calls onClose", async () => {
    const user = userEvent.setup();
    setupSession();
    const onClose = vi.fn();
    render(<AgentPane agentId={AGENT_ID} sessionId={SESSION} onClose={onClose} />);

    await user.click(screen.getByLabelText("Close agent pane"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows streaming indicator when agent is streaming", () => {
    setupSession();
    useStore.getState().initAgentStreaming(SESSION, AGENT_ID);
    useStore.getState().appendAgentStreaming(SESSION, AGENT_ID, "Streaming text...");

    render(<AgentPane agentId={AGENT_ID} sessionId={SESSION} onClose={() => {}} />);
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("resolves status from team members", () => {
    setupSession();
    useStore.getState().setSessionState(SESSION, {
      session_id: SESSION,
      model: "test",
      cwd: "/tmp",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      team: {
        name: "test-team",
        role: "lead",
        members: [makeTeamMember({ name: "researcher", status: "idle" })],
        tasks: [],
      },
    });

    const { container } = render(
      <AgentPane agentId={AGENT_ID} sessionId={SESSION} onClose={() => {}} />,
    );

    // The status dot should have the idle class
    const dot = container.querySelector("span.rounded-full.h-2.w-2");
    expect(dot?.className).toContain("bg-bc-warning");
  });

  it("defaults to 'Agent' name when tool_use block not found", () => {
    useStore.getState().ensureSessionData(SESSION);
    render(<AgentPane agentId="unknown-id" sessionId={SESSION} onClose={() => {}} />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });
});
