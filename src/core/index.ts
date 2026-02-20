// Interfaces

// Core modules
export type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
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
export { SessionBridge } from "./session-bridge.js";
export { SessionManager } from "./session-manager.js";
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
// Types
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
