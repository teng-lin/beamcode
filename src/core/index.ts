// ─── Class exports ───────────────────────────────────────────────────────────

export { BackendConnector } from "./backend-connector.js";
export { CapabilitiesPolicy } from "./capabilities-policy.js";
export { CliGateway } from "./cli-gateway.js";
export { ConsumerGateway } from "./consumer-gateway.js";
export { DomainEventBus } from "./domain-event-bus.js";
export { IdlePolicy } from "./idle-policy.js";

// ─── Interface / type re-exports ─────────────────────────────────────────────
export type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
export type {
  DomainBridgeEventType,
  DomainEvent,
  DomainEventMap,
  DomainEventSource,
  DomainEventType,
} from "./interfaces/domain-events.js";
export type {
  Configurable,
  Encryptable,
  Interruptible,
  PermissionHandler,
  Reconnectable,
  TeamObserver,
} from "./interfaces/extensions.js";
export type { ProcessSupervisorOptions, SupervisorEventMap } from "./process-supervisor.js";
export { ProcessSupervisor } from "./process-supervisor.js";
export { ReconnectPolicy } from "./reconnect-policy.js";
export {
  CORE_RUNTIME_MODES,
  type CoreRuntimeMode,
  DEFAULT_CORE_RUNTIME_MODE,
  isCoreRuntimeMode,
  resolveCoreRuntimeMode,
} from "./runtime-mode.js";
export {
  SessionRuntimeShadow,
  type SessionRuntimeShadowSnapshot,
  SHADOW_LIFECYCLE_STATES,
  type ShadowBackendSignal,
  type ShadowLifecycleState,
} from "./runtime-shadow.js";
export { SessionBridge } from "./session-bridge.js";
export { SessionCoordinator, type SessionCoordinatorOptions } from "./session-coordinator.js";
export {
  isLifecycleTransitionAllowed,
  LIFECYCLE_STATES,
  type LifecycleState,
} from "./session-lifecycle.js";
export { SessionRepository } from "./session-repository.js";
export { SessionRuntime } from "./session-runtime.js";
export { TypedEventEmitter } from "./typed-emitter.js";
export type {
  CoreSessionState,
  DevToolSessionState,
} from "./types/core-session-state.js";
export type { SequencedMessage } from "./types/sequenced-message.js";
export type {
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
} from "./types/team-types.js";
export { isTeamMember, isTeamState, isTeamTask } from "./types/team-types.js";
// ─── Unified message types ───────────────────────────────────────────────────
export type {
  UnifiedContent,
  UnifiedMessage,
  UnifiedMessageType,
} from "./types/unified-message.js";
export {
  canonicalize,
  createUnifiedMessage,
  isTeamMessage,
  isTeamStateChange,
  isTeamTaskUpdate,
  isUnifiedMessage,
} from "./types/unified-message.js";
