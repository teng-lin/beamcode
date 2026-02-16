import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { makeTeamMember, makeToolUseBlock, resetStore } from "../test/factories";
import { AgentRosterBlock } from "./AgentRosterBlock";

const SESSION = "roster-test";

function makeTaskBlock(id: string, name: string, subagentType: string, description = "") {
  return makeToolUseBlock({
    id,
    name: "Task",
    input: { name, subagent_type: subagentType, description },
  });
}

describe("AgentRosterBlock", () => {
  beforeEach(() => {
    resetStore({ currentSessionId: SESSION });
    useStore.getState().ensureSessionData(SESSION);
  });

  it("renders nothing when blocks is empty", () => {
    const { container } = render(<AgentRosterBlock blocks={[]} sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders agent names from input", () => {
    const blocks = [
      makeTaskBlock("t1", "researcher", "general-purpose", "Research docs"),
      makeTaskBlock("t2", "reviewer", "code-reviewer", "Review code"),
    ];
    render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);
    expect(screen.getByText("researcher")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
  });

  it("shows count badge", () => {
    const blocks = [
      makeTaskBlock("t1", "a1", "general-purpose"),
      makeTaskBlock("t2", "a2", "general-purpose"),
      makeTaskBlock("t3", "a3", "general-purpose"),
    ];
    render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows shortened agent type", () => {
    const blocks = [makeTaskBlock("t1", "reviewer", "compound-engineering:review:code-reviewer")];
    render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);
    expect(screen.getByText("code-reviewer")).toBeInTheDocument();
  });

  it("clicking agent calls setInspectedAgent", async () => {
    const user = userEvent.setup();
    const blocks = [makeTaskBlock("t1", "researcher", "general-purpose")];
    render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);

    await user.click(screen.getByText("researcher"));
    expect(useStore.getState().inspectedAgentId).toBe("t1");
  });

  it("clicking same agent toggles inspection off", async () => {
    const user = userEvent.setup();
    useStore.setState({ inspectedAgentId: "t1" });
    const blocks = [makeTaskBlock("t1", "researcher", "general-purpose")];
    render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);

    await user.click(screen.getByText("researcher"));
    expect(useStore.getState().inspectedAgentId).toBeNull();
  });

  it("status dots reflect team member state", () => {
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
        members: [
          makeTeamMember({ name: "researcher", status: "active" }),
          makeTeamMember({ name: "reviewer", agentId: "agent-2", status: "idle" }),
        ],
        tasks: [],
      },
    });

    const blocks = [
      makeTaskBlock("t1", "researcher", "general-purpose"),
      makeTaskBlock("t2", "reviewer", "code-reviewer"),
    ];
    const { container } = render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);

    const dots = container.querySelectorAll("span.rounded-full.h-2.w-2");
    expect(dots).toHaveLength(2);
    // First dot should be active (animate-pulse)
    expect(dots[0].className).toContain("animate-pulse");
    // Second dot should be idle (bg-bc-warning)
    expect(dots[1].className).toContain("bg-bc-warning");
  });

  it("collapses when header is clicked", async () => {
    const user = userEvent.setup();
    const blocks = [makeTaskBlock("t1", "researcher", "general-purpose")];
    render(<AgentRosterBlock blocks={blocks} sessionId={SESSION} />);

    // Agent name visible by default (expanded)
    expect(screen.getByText("researcher")).toBeInTheDocument();

    // Click the header button (first button = header, not the agent row)
    const buttons = screen.getAllByRole("button");
    // First button is the header with "Agent Team" text
    await user.click(buttons[0]);

    // The agent row should be hidden (only "Agent Team" text visible, not "researcher" in expanded list)
    // After collapse, there should be fewer buttons (no agent row buttons)
    const buttonsAfter = screen.getAllByRole("button");
    expect(buttonsAfter).toHaveLength(1); // Only header button
  });
});
