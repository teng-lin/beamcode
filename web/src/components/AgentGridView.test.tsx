import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGridItem } from "../hooks/useAgentGrid";
import { resetStore } from "../test/factories";
import { AgentGridView } from "./AgentGridView";

vi.mock("./AgentColumn", () => ({
  AgentColumn: ({ name }: { name: string }) => <div data-testid={`col-${name}`}>{name}</div>,
}));

const SESSION = "grid-view-test";

const agents: AgentGridItem[] = [
  { blockId: "tu-1", name: "researcher", type: "general-purpose", status: "active", messages: [] },
  { blockId: "tu-2", name: "tester", type: "Bash", status: "idle", messages: [] },
  { blockId: "tu-3", name: "reviewer", type: "code-reviewer", status: "shutdown", messages: [] },
];

describe("AgentGridView", () => {
  beforeEach(() => {
    resetStore({ currentSessionId: SESSION });
  });

  it("renders a column for each agent", () => {
    render(<AgentGridView agents={agents} sessionId={SESSION} />);
    expect(screen.getByTestId("col-researcher")).toBeInTheDocument();
    expect(screen.getByTestId("col-tester")).toBeInTheDocument();
    expect(screen.getByTestId("col-reviewer")).toBeInTheDocument();
  });

  it("renders nothing when agents list is empty", () => {
    const { container } = render(<AgentGridView agents={[]} sessionId={SESSION} />);
    // Container should have no children (no columns)
    expect(container.firstElementChild?.children).toHaveLength(0);
  });
});
