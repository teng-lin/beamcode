export const LIFECYCLE_STATES = [
  "starting",
  "awaiting_backend",
  "active",
  "idle",
  "degraded",
  "closing",
  "closed",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const ALLOWED_TRANSITIONS: Record<LifecycleState, ReadonlySet<LifecycleState>> = {
  starting: new Set(["awaiting_backend", "closing", "closed"]),
  awaiting_backend: new Set(["active", "degraded", "closing", "closed"]),
  active: new Set(["active", "idle", "degraded", "closing", "closed"]),
  idle: new Set(["idle", "active", "degraded", "closing", "closed"]),
  degraded: new Set(["degraded", "awaiting_backend", "active", "closing", "closed"]),
  closing: new Set(["closed"]),
  closed: new Set(["closed"]),
};

export function isLifecycleTransitionAllowed(from: LifecycleState, to: LifecycleState): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
