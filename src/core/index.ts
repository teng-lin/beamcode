// Interfaces

// Core modules
export { CLILauncher } from "./cli-launcher.js";
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
// Types
export type {
  UnifiedContent,
  UnifiedMessage,
  UnifiedMessageType,
} from "./types/unified-message.js";
export {
  canonicalize,
  createUnifiedMessage,
  isUnifiedMessage,
} from "./types/unified-message.js";
