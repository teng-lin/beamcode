import { describe, expect, it } from "vitest";

import { diffTeamState, type TeamEvent } from "./team-event-differ.js";
import type { TeamMember, TeamState, TeamTask } from "./types/team-types.js";

// ── Factories ────────────────────────────────────────────────────────────────

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    name: "worker-1",
    agentId: "agent-1",
    agentType: "general-purpose",
    status: "active",
    ...overrides,
  };
}

function makeTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "task-1",
    subject: "Do something",
    status: "pending",
    blockedBy: [],
    blocks: [],
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamState> = {}): TeamState {
  return {
    name: "alpha",
    role: "lead",
    members: [],
    tasks: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("diffTeamState", () => {
  const SESSION = "sess-1";

  describe("reference equality", () => {
    it("returns empty array when prev === current (same reference)", () => {
      const team = makeTeam();
      expect(diffTeamState(SESSION, team, team)).toEqual([]);
    });

    it("returns empty array when both are undefined", () => {
      expect(diffTeamState(SESSION, undefined, undefined)).toEqual([]);
    });
  });

  describe("team lifecycle", () => {
    it("emits team:created when prev is undefined and current exists", () => {
      const current = makeTeam({ name: "beta" });
      const events = diffTeamState(SESSION, undefined, current);

      expect(events).toEqual([
        { type: "team:created", payload: { sessionId: SESSION, teamName: "beta" } },
      ]);
    });

    it("emits team:deleted when prev exists and current is undefined", () => {
      const prev = makeTeam({ name: "beta" });
      const events = diffTeamState(SESSION, prev, undefined);

      expect(events).toEqual([
        { type: "team:deleted", payload: { sessionId: SESSION, teamName: "beta" } },
      ]);
    });

    it("returns only team:created (no member/task events) on initial creation", () => {
      const current = makeTeam({
        members: [makeMember()],
        tasks: [makeTask()],
      });
      const events = diffTeamState(SESSION, undefined, current);

      // Early return after team:created — does not diff members/tasks
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team:created");
    });
  });

  describe("member diffs", () => {
    it("emits team:member:joined for new members", () => {
      const prev = makeTeam();
      const member = makeMember({ name: "dev-1" });
      const current = makeTeam({ members: [member] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:member:joined", payload: { sessionId: SESSION, member } },
      ]);
    });

    it("emits team:member:idle when status transitions to idle", () => {
      const member = makeMember({ name: "dev-1", status: "active" });
      const prev = makeTeam({ members: [member] });

      const idleMember = { ...member, status: "idle" as const };
      const current = makeTeam({ members: [idleMember] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:member:idle", payload: { sessionId: SESSION, member: idleMember } },
      ]);
    });

    it("emits team:member:shutdown when status transitions to shutdown", () => {
      const member = makeMember({ name: "dev-1", status: "active" });
      const prev = makeTeam({ members: [member] });

      const shutdownMember = { ...member, status: "shutdown" as const };
      const current = makeTeam({ members: [shutdownMember] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:member:shutdown", payload: { sessionId: SESSION, member: shutdownMember } },
      ]);
    });

    it("emits no event for active → active (same status)", () => {
      const member = makeMember({ name: "dev-1", status: "active" });
      const prev = makeTeam({ members: [member] });

      // Different object, same status
      const current = makeTeam({ members: [{ ...member }] });

      const events = diffTeamState(SESSION, prev, current);
      expect(events).toEqual([]);
    });

    it("emits no event for idle → idle (same status)", () => {
      const member = makeMember({ name: "dev-1", status: "idle" });
      const prev = makeTeam({ members: [member] });
      const current = makeTeam({ members: [{ ...member }] });

      expect(diffTeamState(SESSION, prev, current)).toEqual([]);
    });

    it("emits team:member:idle for shutdown → idle transition", () => {
      const member = makeMember({ name: "dev-1", status: "shutdown" });
      const prev = makeTeam({ members: [member] });

      const idleMember = { ...member, status: "idle" as const };
      const current = makeTeam({ members: [idleMember] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:member:idle", payload: { sessionId: SESSION, member: idleMember } },
      ]);
    });

    it("emits no event for idle → active transition (no active event defined)", () => {
      const member = makeMember({ name: "dev-1", status: "idle" });
      const prev = makeTeam({ members: [member] });

      const activeMember = { ...member, status: "active" as const };
      const current = makeTeam({ members: [activeMember] });

      const events = diffTeamState(SESSION, prev, current);

      // Status changed (idle → active) but no event type handles "active" as target
      expect(events).toEqual([]);
    });

    it("emits no event for removed members (in prev but not in current)", () => {
      const member = makeMember({ name: "dev-1" });
      const prev = makeTeam({ members: [member] });
      const current = makeTeam({ members: [] }); // member removed

      const events = diffTeamState(SESSION, prev, current);

      // The differ only iterates current.members — removed members produce no event
      expect(events).toEqual([]);
    });

    it("handles multiple members with mixed changes", () => {
      const m1 = makeMember({ name: "dev-1", status: "active" });
      const m2 = makeMember({ name: "dev-2", status: "active" });
      const prev = makeTeam({ members: [m1, m2] });

      const m1Idle = { ...m1, status: "idle" as const };
      const m3 = makeMember({ name: "dev-3", status: "active" });
      // m2 removed, m1 goes idle, m3 is new
      const current = makeTeam({ members: [m1Idle, m3] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:member:idle", payload: { sessionId: SESSION, member: m1Idle } },
        { type: "team:member:joined", payload: { sessionId: SESSION, member: m3 } },
      ]);
    });
  });

  describe("task diffs", () => {
    it("emits team:task:created for new tasks", () => {
      const prev = makeTeam();
      const task = makeTask({ id: "t-1", subject: "Build feature" });
      const current = makeTeam({ tasks: [task] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:task:created", payload: { sessionId: SESSION, task } },
      ]);
    });

    it("emits team:task:claimed when pending → in_progress with owner", () => {
      const task = makeTask({ id: "t-1", status: "pending" });
      const prev = makeTeam({ tasks: [task] });

      const claimed = { ...task, status: "in_progress" as const, owner: "dev-1" };
      const current = makeTeam({ tasks: [claimed] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:task:claimed", payload: { sessionId: SESSION, task: claimed } },
      ]);
    });

    it("emits team:task:completed when status → completed", () => {
      const task = makeTask({ id: "t-1", status: "in_progress", owner: "dev-1" });
      const prev = makeTeam({ tasks: [task] });

      const completed = { ...task, status: "completed" as const };
      const current = makeTeam({ tasks: [completed] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:task:completed", payload: { sessionId: SESSION, task: completed } },
      ]);
    });

    it("emits team:task:completed for pending → completed (skipping in_progress)", () => {
      const task = makeTask({ id: "t-1", status: "pending" });
      const prev = makeTeam({ tasks: [task] });

      const completed = { ...task, status: "completed" as const };
      const current = makeTeam({ tasks: [completed] });

      const events = diffTeamState(SESSION, prev, current);

      expect(events).toEqual([
        { type: "team:task:completed", payload: { sessionId: SESSION, task: completed } },
      ]);
    });

    it("emits no event when task owner changes without status change", () => {
      const task = makeTask({ id: "t-1", status: "in_progress", owner: "dev-1" });
      const prev = makeTeam({ tasks: [task] });

      const reassigned = { ...task, owner: "dev-2" };
      const current = makeTeam({ tasks: [reassigned] });

      const events = diffTeamState(SESSION, prev, current);

      // Status didn't change — no event emitted
      expect(events).toEqual([]);
    });

    it("emits no event for in_progress → in_progress (same status)", () => {
      const task = makeTask({ id: "t-1", status: "in_progress", owner: "dev-1" });
      const prev = makeTeam({ tasks: [task] });
      const current = makeTeam({ tasks: [{ ...task }] });

      expect(diffTeamState(SESSION, prev, current)).toEqual([]);
    });

    it("emits no event for removed tasks (in prev but not in current)", () => {
      const task = makeTask({ id: "t-1" });
      const prev = makeTeam({ tasks: [task] });
      const current = makeTeam({ tasks: [] });

      // The differ only iterates current.tasks — removed tasks produce no event
      expect(diffTeamState(SESSION, prev, current)).toEqual([]);
    });

    it("does not emit team:task:claimed when in_progress has no owner", () => {
      const task = makeTask({ id: "t-1", status: "pending" });
      const prev = makeTeam({ tasks: [task] });

      // in_progress but no owner — the condition requires both
      const inProgress = { ...task, status: "in_progress" as const };
      const current = makeTeam({ tasks: [inProgress] });

      const events = diffTeamState(SESSION, prev, current);

      // Status changed to in_progress but no owner → no claimed event
      expect(events).toEqual([]);
    });

    it("emits no event for status → deleted (not handled)", () => {
      const task = makeTask({ id: "t-1", status: "pending" });
      const prev = makeTeam({ tasks: [task] });

      const deleted = { ...task, status: "deleted" as const };
      const current = makeTeam({ tasks: [deleted] });

      const events = diffTeamState(SESSION, prev, current);

      // Status changed but "deleted" is not handled by the differ
      expect(events).toEqual([]);
    });
  });

  describe("combined member + task diffs", () => {
    it("emits both member and task events in a single diff", () => {
      const prev = makeTeam({
        members: [makeMember({ name: "dev-1", status: "active" })],
        tasks: [makeTask({ id: "t-1", status: "pending" })],
      });

      const current = makeTeam({
        members: [
          makeMember({ name: "dev-1", status: "idle" }),
          makeMember({ name: "dev-2", status: "active" }),
        ],
        tasks: [
          makeTask({ id: "t-1", status: "completed" }),
          makeTask({ id: "t-2", subject: "New task" }),
        ],
      });

      const events = diffTeamState(SESSION, prev, current);

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "team:member:idle",
        "team:member:joined",
        "team:task:completed",
        "team:task:created",
      ]);
    });
  });
});
