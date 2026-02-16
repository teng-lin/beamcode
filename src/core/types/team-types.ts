/**
 * Team types — Phase 5.1
 *
 * Type definitions for agent team coordination. BeamCode derives team state
 * from observed tool_use / tool_result content blocks in the SDK stream.
 * These types represent the derived state and events.
 */

// ---------------------------------------------------------------------------
// Team Member
// ---------------------------------------------------------------------------

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  status: "active" | "idle" | "shutdown";
  model?: string;
  color?: string;
}

const VALID_MEMBER_STATUSES = new Set(["active", "idle", "shutdown"]);

// ---------------------------------------------------------------------------
// Team Task
// ---------------------------------------------------------------------------

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  activeForm?: string;
  blockedBy: string[];
  blocks: string[];
}

const VALID_TASK_STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);

// ---------------------------------------------------------------------------
// Team State (embedded in SessionState)
// ---------------------------------------------------------------------------

export interface TeamState {
  name: string;
  role: "lead" | "teammate";
  members: TeamMember[];
  tasks: TeamTask[];
}

const VALID_ROLES = new Set(["lead", "teammate"]);

// ---------------------------------------------------------------------------
// Team Events (emitted via TeamObserver extension interface)
// ---------------------------------------------------------------------------

export type TeamEvent =
  | TeamMessageEvent
  | TeamIdleEvent
  | TeamShutdownRequestEvent
  | TeamShutdownResponseEvent
  | TeamPlanApprovalRequestEvent
  | TeamPlanApprovalResponseEvent
  | TeamMemberEvent
  | TeamTaskEvent;

export interface TeamMessageEvent {
  type: "message";
  from: string;
  to?: string; // undefined = broadcast
  content: string;
  summary?: string;
}

export interface TeamIdleEvent {
  type: "idle";
  from: string;
  completedTaskId?: string;
}

export interface TeamShutdownRequestEvent {
  type: "shutdown_request";
  from: string;
  to: string;
  requestId: string;
  reason?: string;
}

export interface TeamShutdownResponseEvent {
  type: "shutdown_response";
  from: string;
  requestId: string;
  approved: boolean;
  reason?: string;
}

export interface TeamPlanApprovalRequestEvent {
  type: "plan_approval_request";
  from: string;
  to: string;
  requestId: string;
  plan: string;
}

export interface TeamPlanApprovalResponseEvent {
  type: "plan_approval_response";
  from: string;
  to: string;
  requestId: string;
  approved: boolean;
  feedback?: string;
}

export interface TeamMemberEvent {
  type: "member_joined" | "member_left" | "member_idle" | "member_active";
  member: TeamMember;
}

export interface TeamTaskEvent {
  type: "task_created" | "task_claimed" | "task_completed" | "task_updated";
  task: TeamTask;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTeamMember(value: unknown): value is TeamMember {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.agentId === "string" &&
    typeof v.agentType === "string" &&
    typeof v.status === "string" &&
    VALID_MEMBER_STATUSES.has(v.status)
  );
}

export function isTeamTask(value: unknown): value is TeamTask {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.subject === "string" &&
    typeof v.status === "string" &&
    VALID_TASK_STATUSES.has(v.status) &&
    Array.isArray(v.blockedBy) &&
    Array.isArray(v.blocks)
  );
}

export function isTeamState(value: unknown): value is TeamState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.role === "string" &&
    VALID_ROLES.has(v.role) &&
    Array.isArray(v.members) &&
    Array.isArray(v.tasks)
  );
}
