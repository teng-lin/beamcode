import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { makeTeamMember, makeTeamState, makeTeamTask, resetStore, store } from "../test/factories";
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

  it("renders lines added/removed when available", () => {
    store().ensureSessionData(SESSION);
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp",
      total_cost_usd: 0.1,
      num_turns: 3,
      context_used_percent: 30,
      is_compacting: false,
      total_lines_added: 42,
      total_lines_removed: 10,
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<TaskPanel />);

    expect(screen.getByText("+42")).toBeInTheDocument();
    expect(screen.getByText("-10")).toBeInTheDocument();
  });

  it("does not render lines section when lines data is absent", () => {
    store().ensureSessionData(SESSION);
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp",
      total_cost_usd: 0.1,
      num_turns: 3,
      context_used_percent: 30,
      is_compacting: false,
    });
    useStore.setState({ currentSessionId: SESSION });
    render(<TaskPanel />);

    expect(screen.queryByText("Lines")).not.toBeInTheDocument();
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
    // Should show formatted token counts separately
    expect(screen.getByText("1.0k")).toBeInTheDocument(); // inputTokens
    expect(screen.getByText("500")).toBeInTheDocument(); // outputTokens
  });

  // ── Team display ─────────────────────────────────────────────────────

  describe("team members", () => {
    it("does not render Team Members section when no team", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
      });
      useStore.setState({ currentSessionId: SESSION });
      render(<TaskPanel />);
      expect(screen.queryByText("Team Members")).not.toBeInTheDocument();
    });

    it("renders Team Members section when team is present", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        team: makeTeamState({
          members: [
            makeTeamMember({ name: "researcher", agentType: "Explore" }),
            makeTeamMember({
              name: "coder",
              agentId: "agent-2",
              agentType: "general-purpose",
              status: "idle",
            }),
          ],
        }),
      });
      useStore.setState({ currentSessionId: SESSION });
      render(<TaskPanel />);

      expect(screen.getByText("Team Members")).toBeInTheDocument();
      expect(screen.getByText("researcher")).toBeInTheDocument();
      expect(screen.getByText("coder")).toBeInTheDocument();
      expect(screen.getByText("Explore")).toBeInTheDocument();
    });

    it("shows 'No members' when team has empty members", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        team: makeTeamState({ members: [] }),
      });
      useStore.setState({ currentSessionId: SESSION });
      render(<TaskPanel />);

      expect(screen.getByText("No members")).toBeInTheDocument();
    });
  });

  describe("team tasks", () => {
    it("does not render Team Tasks when no team", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
      });
      useStore.setState({ currentSessionId: SESSION });
      render(<TaskPanel />);
      expect(screen.queryByText("Team Tasks")).not.toBeInTheDocument();
    });

    it("renders task list with progress bar", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        team: makeTeamState({
          tasks: [
            makeTeamTask({ id: "t1", subject: "Research API", status: "completed" }),
            makeTeamTask({
              id: "t2",
              subject: "Write code",
              status: "in_progress",
              owner: "coder",
              activeForm: "Writing code",
            }),
            makeTeamTask({ id: "t3", subject: "Write tests", status: "pending" }),
          ],
        }),
      });
      useStore.setState({ currentSessionId: SESSION });
      render(<TaskPanel />);

      expect(screen.getByText("Team Tasks")).toBeInTheDocument();
      expect(screen.getByText("1/3")).toBeInTheDocument();
      expect(screen.getByText("Research API")).toBeInTheDocument();
      expect(screen.getByText("Write code")).toBeInTheDocument();
      expect(screen.getByText("coder")).toBeInTheDocument();
      expect(screen.getByText("Writing code")).toBeInTheDocument();
      expect(screen.getByText("Write tests")).toBeInTheDocument();
    });

    it("excludes deleted tasks from display", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        team: makeTeamState({
          tasks: [
            makeTeamTask({ id: "t1", subject: "Active task", status: "pending" }),
            makeTeamTask({ id: "t2", subject: "Deleted task", status: "deleted" }),
          ],
        }),
      });
      useStore.setState({ currentSessionId: SESSION });
      render(<TaskPanel />);

      expect(screen.getByText("Active task")).toBeInTheDocument();
      expect(screen.queryByText("Deleted task")).not.toBeInTheDocument();
      expect(screen.getByText("0/1")).toBeInTheDocument();
    });
  });

  // ── Enhanced cost/token tracking ────────────────────────────────────

  describe("enhanced cost tracking", () => {
    it("shows total input and output tokens separately", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0.05,
        num_turns: 3,
        context_used_percent: 45,
        is_compacting: false,
        last_model_usage: {
          "claude-3-opus": {
            inputTokens: 5000,
            outputTokens: 2000,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 500,
            contextWindow: 200000,
            costUSD: 0.05,
          },
        },
      });
      useStore.setState({ currentSessionId: SESSION });

      render(<TaskPanel />);

      expect(screen.getByText("5.0k")).toBeInTheDocument();
      expect(screen.getByText("2.0k")).toBeInTheDocument();
    });

    it("shows cache hit ratio when cache data exists", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0.05,
        num_turns: 3,
        context_used_percent: 45,
        is_compacting: false,
        last_model_usage: {
          "claude-3-opus": {
            inputTokens: 5000,
            outputTokens: 2000,
            cacheReadInputTokens: 3000,
            cacheCreationInputTokens: 500,
            contextWindow: 200000,
            costUSD: 0.05,
          },
        },
      });
      useStore.setState({ currentSessionId: SESSION });

      render(<TaskPanel />);

      expect(screen.getByText(/cache/i)).toBeInTheDocument();
    });

    it("does not show cache ratio when no cache reads", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0.05,
        num_turns: 3,
        context_used_percent: 45,
        is_compacting: false,
        last_model_usage: {
          "claude-3-opus": {
            inputTokens: 5000,
            outputTokens: 2000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
            costUSD: 0.05,
          },
        },
      });
      useStore.setState({ currentSessionId: SESSION });

      render(<TaskPanel />);

      expect(screen.queryByText(/cache/i)).not.toBeInTheDocument();
    });

    it("shows per-model cost formatted", () => {
      store().ensureSessionData(SESSION);
      store().setSessionState(SESSION, {
        session_id: SESSION,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0.15,
        num_turns: 3,
        context_used_percent: 45,
        is_compacting: false,
        last_model_usage: {
          "claude-3-opus": {
            inputTokens: 5000,
            outputTokens: 2000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
            costUSD: 0.05,
          },
        },
      });
      useStore.setState({ currentSessionId: SESSION });

      render(<TaskPanel />);

      // Total cost: $0.150, per-model cost: $0.050
      expect(screen.getByText("$0.150")).toBeInTheDocument();
      expect(screen.getByText("$0.050")).toBeInTheDocument();
    });
  });
});
