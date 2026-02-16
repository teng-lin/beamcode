import type { ConsumerMessage, ConsumerTeamMember } from "../../../shared/consumer-types";

// ── Shared types for agent/team UI ──────────────────────────────────────────

export interface TaskToolInput {
  name?: string;
  subagent_type?: string;
  description?: string;
  run_in_background?: boolean;
}

// ── Stable empty-array sentinels (prevent useShallow re-renders) ────────────

export const EMPTY_MEMBERS: ConsumerTeamMember[] = [];
export const EMPTY_MESSAGES: ConsumerMessage[] = [];

// ── Status styling constants ────────────────────────────────────────────────

const DEFAULT_STATUS_DOT = "bg-bc-text-muted/40";

export const MEMBER_STATUS_STYLES: Record<string, string> = {
  active: "bg-bc-success animate-pulse",
  idle: "bg-bc-warning",
  shutdown: DEFAULT_STATUS_DOT,
};

export const TASK_STATUS_ICONS: Record<string, string> = {
  pending: "\u25CB",
  in_progress: "\u25D1",
  completed: "\u25CF",
  deleted: "\u2715",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the Tailwind dot class for a member status, with a safe fallback. */
export function memberStatusDotClass(status: string): string {
  return MEMBER_STATUS_STYLES[status] ?? DEFAULT_STATUS_DOT;
}

/** Shorten agent type: "compound-engineering:review:code-reviewer" -> "code-reviewer" */
export function shortAgentType(type: string): string {
  const parts = type.split(":");
  return parts[parts.length - 1];
}
