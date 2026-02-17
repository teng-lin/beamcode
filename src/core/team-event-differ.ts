/**
 * TeamEventDiffer — extracted from SessionBridge (Phase 4).
 *
 * Pure functions that diff previous and current TeamState to produce
 * a list of typed events. Zero coupling to bridge internals.
 */

import type { BridgeEventMap } from "../types/events.js";
import type { TeamState } from "./types/team-types.js";

// ─── Event type ──────────────────────────────────────────────────────────────

export interface TeamEvent {
  type: keyof BridgeEventMap;
  payload: Record<string, unknown>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Diff previous and current team state, returning a list of events to emit.
 * Returns an empty array if there is no change (reference equality).
 */
export function diffTeamState(
  sessionId: string,
  prev: TeamState | undefined,
  current: TeamState | undefined,
): TeamEvent[] {
  // No change (reference equality)
  if (prev === current) return [];

  const events: TeamEvent[] = [];

  // Team created
  if (!prev && current) {
    events.push({ type: "team:created", payload: { sessionId, teamName: current.name } });
    return events;
  }

  // Team deleted
  if (prev && !current) {
    events.push({ type: "team:deleted", payload: { sessionId, teamName: prev.name } });
    return events;
  }

  // Both exist — diff members and tasks
  if (prev && current) {
    events.push(...diffTeamMembers(sessionId, prev, current));
    events.push(...diffTeamTasks(sessionId, prev, current));
  }

  return events;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function diffTeamMembers(sessionId: string, prev: TeamState, current: TeamState): TeamEvent[] {
  const events: TeamEvent[] = [];
  const prevMemberMap = new Map(prev.members.map((m) => [m.name, m]));

  for (const member of current.members) {
    const prevMember = prevMemberMap.get(member.name);
    if (!prevMember) {
      events.push({ type: "team:member:joined", payload: { sessionId, member } });
      continue;
    }

    if (prevMember.status !== member.status) {
      if (member.status === "idle") {
        events.push({ type: "team:member:idle", payload: { sessionId, member } });
      } else if (member.status === "shutdown") {
        events.push({ type: "team:member:shutdown", payload: { sessionId, member } });
      }
    }
  }

  return events;
}

function diffTeamTasks(sessionId: string, prev: TeamState, current: TeamState): TeamEvent[] {
  const events: TeamEvent[] = [];
  const prevTaskMap = new Map(prev.tasks.map((t) => [t.id, t]));

  for (const task of current.tasks) {
    const prevTask = prevTaskMap.get(task.id);
    if (!prevTask) {
      events.push({ type: "team:task:created", payload: { sessionId, task } });
      continue;
    }

    if (prevTask.status !== task.status) {
      if (task.status === "in_progress" && task.owner) {
        events.push({ type: "team:task:claimed", payload: { sessionId, task } });
      } else if (task.status === "completed") {
        events.push({ type: "team:task:completed", payload: { sessionId, task } });
      }
    }
  }

  return events;
}
