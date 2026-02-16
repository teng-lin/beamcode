import { describe, expect, it } from "vitest";
import type { SessionState } from "../../types/session-state.js";
import type { BackendCapabilities } from "../interfaces/backend-adapter.js";
import type { TeamObserver } from "../interfaces/extensions.js";
import type {
  TeamEvent,
  TeamIdleEvent,
  TeamMember,
  TeamMemberEvent,
  TeamMessageEvent,
  TeamPlanApprovalRequestEvent,
  TeamPlanApprovalResponseEvent,
  TeamShutdownRequestEvent,
  TeamShutdownResponseEvent,
  TeamState,
  TeamTask,
  TeamTaskEvent,
} from "./team-types.js";
import { isTeamMember, isTeamState, isTeamTask } from "./team-types.js";
import type { UnifiedMessage } from "./unified-message.js";
import {
  createUnifiedMessage,
  isTeamMessage,
  isTeamStateChange,
  isTeamTaskUpdate,
  isUnifiedMessage,
} from "./unified-message.js";

// ---------------------------------------------------------------------------
// isTeamMember type guard
// ---------------------------------------------------------------------------

describe("isTeamMember", () => {
  it("accepts a valid TeamMember", () => {
    const member: TeamMember = {
      name: "worker-1",
      agentId: "worker-1@my-team",
      agentType: "general-purpose",
      status: "active",
    };
    expect(isTeamMember(member)).toBe(true);
  });

  it("accepts a TeamMember with optional fields", () => {
    const member: TeamMember = {
      name: "team-lead",
      agentId: "team-lead@my-team",
      agentType: "team-lead",
      status: "idle",
      model: "claude-opus-4-6",
      color: "blue",
    };
    expect(isTeamMember(member)).toBe(true);
  });

  it("accepts all valid status values", () => {
    for (const status of ["active", "idle", "shutdown"] as const) {
      expect(
        isTeamMember({
          name: "agent",
          agentId: "agent@team",
          agentType: "general-purpose",
          status,
        }),
      ).toBe(true);
    }
  });

  it("rejects null", () => {
    expect(isTeamMember(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isTeamMember(undefined)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isTeamMember("string")).toBe(false);
    expect(isTeamMember(42)).toBe(false);
  });

  it("rejects missing name", () => {
    expect(
      isTeamMember({
        agentId: "a@t",
        agentType: "general-purpose",
        status: "active",
      }),
    ).toBe(false);
  });

  it("rejects missing agentId", () => {
    expect(
      isTeamMember({
        name: "worker",
        agentType: "general-purpose",
        status: "active",
      }),
    ).toBe(false);
  });

  it("rejects missing agentType", () => {
    expect(
      isTeamMember({
        name: "worker",
        agentId: "a@t",
        status: "active",
      }),
    ).toBe(false);
  });

  it("rejects missing status", () => {
    expect(
      isTeamMember({
        name: "worker",
        agentId: "a@t",
        agentType: "general-purpose",
      }),
    ).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(
      isTeamMember({
        name: "worker",
        agentId: "a@t",
        agentType: "general-purpose",
        status: "running",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTeamTask type guard
// ---------------------------------------------------------------------------

describe("isTeamTask", () => {
  it("accepts a valid TeamTask", () => {
    const task: TeamTask = {
      id: "1",
      subject: "Fix the bug",
      status: "pending",
      blockedBy: [],
      blocks: [],
    };
    expect(isTeamTask(task)).toBe(true);
  });

  it("accepts a TeamTask with optional fields", () => {
    const task: TeamTask = {
      id: "2",
      subject: "Write tests",
      description: "Cover edge cases",
      status: "in_progress",
      owner: "worker-1",
      activeForm: "Writing tests",
      blockedBy: ["1"],
      blocks: ["3"],
    };
    expect(isTeamTask(task)).toBe(true);
  });

  it("accepts all valid status values", () => {
    for (const status of ["pending", "in_progress", "completed", "deleted"] as const) {
      expect(
        isTeamTask({
          id: "1",
          subject: "Test",
          status,
          blockedBy: [],
          blocks: [],
        }),
      ).toBe(true);
    }
  });

  it("rejects null", () => {
    expect(isTeamTask(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isTeamTask(undefined)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isTeamTask("string")).toBe(false);
  });

  it("rejects missing id", () => {
    expect(
      isTeamTask({
        subject: "Test",
        status: "pending",
        blockedBy: [],
        blocks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing subject", () => {
    expect(
      isTeamTask({
        id: "1",
        status: "pending",
        blockedBy: [],
        blocks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing status", () => {
    expect(
      isTeamTask({
        id: "1",
        subject: "Test",
        blockedBy: [],
        blocks: [],
      }),
    ).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(
      isTeamTask({
        id: "1",
        subject: "Test",
        status: "running",
        blockedBy: [],
        blocks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing blockedBy", () => {
    expect(
      isTeamTask({
        id: "1",
        subject: "Test",
        status: "pending",
        blocks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing blocks", () => {
    expect(
      isTeamTask({
        id: "1",
        subject: "Test",
        status: "pending",
        blockedBy: [],
      }),
    ).toBe(false);
  });

  it("rejects non-array blockedBy", () => {
    expect(
      isTeamTask({
        id: "1",
        subject: "Test",
        status: "pending",
        blockedBy: "not-array",
        blocks: [],
      }),
    ).toBe(false);
  });

  it("rejects non-array blocks", () => {
    expect(
      isTeamTask({
        id: "1",
        subject: "Test",
        status: "pending",
        blockedBy: [],
        blocks: "not-array",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTeamState type guard
// ---------------------------------------------------------------------------

describe("isTeamState", () => {
  it("accepts a valid TeamState", () => {
    const state: TeamState = {
      name: "my-team",
      role: "lead",
      members: [],
      tasks: [],
    };
    expect(isTeamState(state)).toBe(true);
  });

  it("accepts a TeamState with members and tasks", () => {
    const state: TeamState = {
      name: "project-team",
      role: "teammate",
      members: [
        {
          name: "worker-1",
          agentId: "worker-1@project-team",
          agentType: "general-purpose",
          status: "active",
        },
      ],
      tasks: [
        {
          id: "1",
          subject: "Implement feature",
          status: "in_progress",
          owner: "worker-1",
          blockedBy: [],
          blocks: [],
        },
      ],
    };
    expect(isTeamState(state)).toBe(true);
  });

  it("accepts both role values", () => {
    for (const role of ["lead", "teammate"] as const) {
      expect(
        isTeamState({
          name: "team",
          role,
          members: [],
          tasks: [],
        }),
      ).toBe(true);
    }
  });

  it("rejects null", () => {
    expect(isTeamState(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isTeamState(undefined)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isTeamState("string")).toBe(false);
  });

  it("rejects missing name", () => {
    expect(
      isTeamState({
        role: "lead",
        members: [],
        tasks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing role", () => {
    expect(
      isTeamState({
        name: "team",
        members: [],
        tasks: [],
      }),
    ).toBe(false);
  });

  it("rejects invalid role", () => {
    expect(
      isTeamState({
        name: "team",
        role: "observer",
        members: [],
        tasks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing members", () => {
    expect(
      isTeamState({
        name: "team",
        role: "lead",
        tasks: [],
      }),
    ).toBe(false);
  });

  it("rejects non-array members", () => {
    expect(
      isTeamState({
        name: "team",
        role: "lead",
        members: "not-array",
        tasks: [],
      }),
    ).toBe(false);
  });

  it("rejects missing tasks", () => {
    expect(
      isTeamState({
        name: "team",
        role: "lead",
        members: [],
      }),
    ).toBe(false);
  });

  it("rejects non-array tasks", () => {
    expect(
      isTeamState({
        name: "team",
        role: "lead",
        members: [],
        tasks: "not-array",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TeamState construction and validation
// ---------------------------------------------------------------------------

describe("TeamState construction", () => {
  it("can represent a full team lifecycle state", () => {
    const state: TeamState = {
      name: "agent-teams-impl",
      role: "lead",
      members: [
        {
          name: "team-lead",
          agentId: "team-lead@agent-teams-impl",
          agentType: "team-lead",
          status: "active",
          model: "claude-opus-4-6",
          color: "green",
        },
        {
          name: "worker-1",
          agentId: "worker-1@agent-teams-impl",
          agentType: "general-purpose",
          status: "idle",
          model: "claude-sonnet-4-5-20250929",
          color: "blue",
        },
        {
          name: "worker-2",
          agentId: "worker-2@agent-teams-impl",
          agentType: "general-purpose",
          status: "shutdown",
        },
      ],
      tasks: [
        {
          id: "1",
          subject: "Type definitions",
          description: "Define all team types",
          status: "completed",
          owner: "worker-1",
          activeForm: "Defining types",
          blockedBy: [],
          blocks: ["2", "3"],
        },
        {
          id: "2",
          subject: "Tool recognizer",
          status: "in_progress",
          owner: "worker-1",
          blockedBy: ["1"],
          blocks: [],
        },
        {
          id: "3",
          subject: "State reducer",
          status: "pending",
          blockedBy: ["1"],
          blocks: [],
        },
      ],
    };

    expect(isTeamState(state)).toBe(true);
    expect(state.members).toHaveLength(3);
    expect(state.tasks).toHaveLength(3);
    expect(state.members[0].model).toBe("claude-opus-4-6");
    expect(state.tasks[0].blocks).toEqual(["2", "3"]);
  });
});

// ---------------------------------------------------------------------------
// TeamEvent types — structural correctness
// ---------------------------------------------------------------------------

describe("TeamEvent types", () => {
  it("TeamMessageEvent is well-formed", () => {
    const event: TeamMessageEvent = {
      type: "message",
      from: "worker-1",
      to: "team-lead",
      content: "Task complete",
      summary: "Task done",
    };
    expect(event.type).toBe("message");
    expect(event.to).toBe("team-lead");
  });

  it("TeamMessageEvent broadcast has no to field", () => {
    const event: TeamMessageEvent = {
      type: "message",
      from: "team-lead",
      content: "All stop",
    };
    expect(event.to).toBeUndefined();
  });

  it("TeamIdleEvent is well-formed", () => {
    const event: TeamIdleEvent = {
      type: "idle",
      from: "worker-1",
      completedTaskId: "3",
    };
    expect(event.type).toBe("idle");
    expect(event.completedTaskId).toBe("3");
  });

  it("TeamShutdownRequestEvent is well-formed", () => {
    const event: TeamShutdownRequestEvent = {
      type: "shutdown_request",
      from: "team-lead",
      to: "worker-1",
      requestId: "req-1",
      reason: "All tasks done",
    };
    expect(event.type).toBe("shutdown_request");
  });

  it("TeamShutdownResponseEvent is well-formed", () => {
    const event: TeamShutdownResponseEvent = {
      type: "shutdown_response",
      from: "worker-1",
      requestId: "req-1",
      approved: true,
    };
    expect(event.type).toBe("shutdown_response");
    expect(event.approved).toBe(true);
  });

  it("TeamPlanApprovalRequestEvent is well-formed", () => {
    const event: TeamPlanApprovalRequestEvent = {
      type: "plan_approval_request",
      from: "worker-1",
      to: "team-lead",
      requestId: "plan-1",
      plan: "I will implement X then Y",
    };
    expect(event.type).toBe("plan_approval_request");
  });

  it("TeamPlanApprovalResponseEvent is well-formed", () => {
    const event: TeamPlanApprovalResponseEvent = {
      type: "plan_approval_response",
      from: "team-lead",
      to: "worker-1",
      requestId: "plan-1",
      approved: false,
      feedback: "Add error handling first",
    };
    expect(event.type).toBe("plan_approval_response");
    expect(event.approved).toBe(false);
  });

  it("TeamMemberEvent is well-formed", () => {
    const event: TeamMemberEvent = {
      type: "member_joined",
      member: {
        name: "worker-1",
        agentId: "worker-1@team",
        agentType: "general-purpose",
        status: "active",
      },
    };
    expect(event.type).toBe("member_joined");
  });

  it("TeamMemberEvent supports all type values", () => {
    const types = ["member_joined", "member_left", "member_idle", "member_active"] as const;
    for (const type of types) {
      const event: TeamMemberEvent = {
        type,
        member: {
          name: "worker",
          agentId: "w@t",
          agentType: "general-purpose",
          status: "active",
        },
      };
      expect(event.type).toBe(type);
    }
  });

  it("TeamTaskEvent is well-formed", () => {
    const event: TeamTaskEvent = {
      type: "task_created",
      task: {
        id: "1",
        subject: "Test task",
        status: "pending",
        blockedBy: [],
        blocks: [],
      },
    };
    expect(event.type).toBe("task_created");
  });

  it("TeamTaskEvent supports all type values", () => {
    const types = ["task_created", "task_claimed", "task_completed", "task_updated"] as const;
    for (const type of types) {
      const event: TeamTaskEvent = {
        type,
        task: {
          id: "1",
          subject: "Test",
          status: "pending",
          blockedBy: [],
          blocks: [],
        },
      };
      expect(event.type).toBe(type);
    }
  });

  it("TeamEvent discriminated union covers all variants", () => {
    const events: TeamEvent[] = [
      { type: "message", from: "a", content: "hi" },
      { type: "idle", from: "a" },
      { type: "shutdown_request", from: "a", to: "b", requestId: "r1" },
      { type: "shutdown_response", from: "a", requestId: "r1", approved: true },
      { type: "plan_approval_request", from: "a", to: "b", requestId: "p1", plan: "plan" },
      { type: "plan_approval_response", from: "a", to: "b", requestId: "p1", approved: true },
      {
        type: "member_joined",
        member: { name: "w", agentId: "w@t", agentType: "gp", status: "active" },
      },
      {
        type: "task_created",
        task: { id: "1", subject: "T", status: "pending", blockedBy: [], blocks: [] },
      },
    ];
    expect(events).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// UnifiedMessage team type guards
// ---------------------------------------------------------------------------

describe("team message type guards", () => {
  function makeMsg(type: string): UnifiedMessage {
    return createUnifiedMessage({
      type: type as UnifiedMessage["type"],
      role: "system",
    });
  }

  it("isTeamMessage identifies team_message type", () => {
    expect(isTeamMessage(makeMsg("team_message"))).toBe(true);
    expect(isTeamMessage(makeMsg("assistant"))).toBe(false);
    expect(isTeamMessage(makeMsg("team_task_update"))).toBe(false);
    expect(isTeamMessage(makeMsg("team_state_change"))).toBe(false);
  });

  it("isTeamTaskUpdate identifies team_task_update type", () => {
    expect(isTeamTaskUpdate(makeMsg("team_task_update"))).toBe(true);
    expect(isTeamTaskUpdate(makeMsg("assistant"))).toBe(false);
    expect(isTeamTaskUpdate(makeMsg("team_message"))).toBe(false);
  });

  it("isTeamStateChange identifies team_state_change type", () => {
    expect(isTeamStateChange(makeMsg("team_state_change"))).toBe(true);
    expect(isTeamStateChange(makeMsg("assistant"))).toBe(false);
    expect(isTeamStateChange(makeMsg("team_message"))).toBe(false);
  });

  it("new team types pass isUnifiedMessage validation", () => {
    expect(isUnifiedMessage(makeMsg("team_message"))).toBe(true);
    expect(isUnifiedMessage(makeMsg("team_task_update"))).toBe(true);
    expect(isUnifiedMessage(makeMsg("team_state_change"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BackendCapabilities teams field
// ---------------------------------------------------------------------------

describe("BackendCapabilities teams field", () => {
  it("accepts capabilities with teams: true", () => {
    const caps: BackendCapabilities = {
      streaming: true,
      permissions: true,
      slashCommands: true,
      availability: "local",
      teams: true,
    };
    expect(caps.teams).toBe(true);
  });

  it("accepts capabilities with teams: false", () => {
    const caps: BackendCapabilities = {
      streaming: false,
      permissions: false,
      slashCommands: false,
      availability: "remote",
      teams: false,
    };
    expect(caps.teams).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TeamObserver extension interface
// ---------------------------------------------------------------------------

describe("TeamObserver extension", () => {
  it("has the expected shape", () => {
    // Structural type check — create a mock that satisfies TeamObserver
    const observer: TeamObserver = {
      teamName: "my-team",
      teamEvents: (async function* () {
        yield {
          type: "message" as const,
          from: "worker",
          content: "hello",
        };
      })(),
    };
    expect(observer.teamName).toBe("my-team");
  });

  it("teamEvents is async iterable", async () => {
    const events: TeamEvent[] = [
      { type: "message", from: "w", content: "hi" },
      {
        type: "member_joined",
        member: { name: "w", agentId: "w@t", agentType: "gp", status: "active" },
      },
    ];

    const observer: TeamObserver = {
      teamName: "test-team",
      teamEvents: (async function* () {
        for (const e of events) yield e;
      })(),
    };

    const collected: TeamEvent[] = [];
    for await (const event of observer.teamEvents) {
      collected.push(event);
    }
    expect(collected).toEqual(events);
  });
});

// ---------------------------------------------------------------------------
// SessionState backward compat: agents field still present
// ---------------------------------------------------------------------------

describe("SessionState backward compatibility", () => {
  it("agents field is still present", () => {
    const state: SessionState = {
      session_id: "test",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: ["worker-1", "worker-2"],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    };
    expect(state.agents).toEqual(["worker-1", "worker-2"]);
  });

  it("team field is optional", () => {
    const state: SessionState = {
      session_id: "test",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    };
    expect(state.team).toBeUndefined();
  });

  it("team field can be populated alongside agents", () => {
    const team: TeamState = {
      name: "my-team",
      role: "lead",
      members: [
        {
          name: "worker-1",
          agentId: "worker-1@my-team",
          agentType: "general-purpose",
          status: "active",
        },
      ],
      tasks: [],
    };

    const state: SessionState = {
      session_id: "test",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: ["worker-1"],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      team,
    };

    expect(state.team).toBeDefined();
    expect(state.team!.members).toHaveLength(1);
    expect(state.agents).toEqual(["worker-1"]);
  });
});
