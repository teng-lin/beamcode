import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { resetStore, store } from "../test/factories";
import { TaskPanel } from "./TaskPanel";

const SESSION = "task-panel-test";

describe("TaskPanel", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when no current session", () => {
    const { container } = render(<TaskPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no session data", () => {
    useStore.setState({ currentSessionId: SESSION });
    const { container } = render(<TaskPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Session Info" heading', () => {
    store().ensureSessionData(SESSION);
    useStore.setState({ currentSessionId: SESSION });
    render(<TaskPanel />);
    expect(screen.getByText("Session Info")).toBeInTheDocument();
  });

  it("renders cost and turns stats", () => {
    store().ensureSessionData(SESSION);
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp",
      total_cost_usd: 0.1234,
      num_turns: 5,
      context_used_percent: 42,
      is_compacting: false,
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<TaskPanel />);

    expect(screen.getByText("$0.123")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders context gauge", () => {
    store().ensureSessionData(SESSION);
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 65,
      is_compacting: false,
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<TaskPanel />);

    expect(screen.getByText("Context Window")).toBeInTheDocument();
  });

  it("renders model usage breakdown when available", () => {
    store().ensureSessionData(SESSION);
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp",
      total_cost_usd: 0.5,
      num_turns: 3,
      context_used_percent: 30,
      is_compacting: false,
      last_model_usage: {
        "claude-sonnet-4-20250514": {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
          contextWindow: 200000,
          costUSD: 0.05,
        },
      },
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<TaskPanel />);

    expect(screen.getByText("Model Usage")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-20250514")).toBeInTheDocument();
    expect(screen.getByText(/1500 tokens/)).toBeInTheDocument();
  });
});
