/**
 * BeamCode public API barrel.
 *
 * Re-exports core classes, interfaces, types, adapters, and utilities that make up
 * the public surface area of the `beamcode` package.
 * @module
 */

export type { ClaudeLauncherOptions } from "./adapters/claude/claude-launcher.js";
export {
  ClaudeLauncher,
  ClaudeLauncher as CLILauncher,
} from "./adapters/claude/claude-launcher.js";
// Adapters
export { CompositeMetricsCollector } from "./adapters/composite-metrics-collector.js";
export { ConsoleLogger } from "./adapters/console-logger.js";
export { ConsoleMetricsCollector } from "./adapters/console-metrics-collector.js";
export { DefaultGitResolver } from "./adapters/default-git-resolver.js";
export { ErrorAggregator } from "./adapters/error-aggregator.js";
export { FileStorage } from "./adapters/file-storage.js";
export { MemoryStorage } from "./adapters/memory-storage.js";
export { NodeProcessManager } from "./adapters/node-process-manager.js";
export type { NodeWebSocketServerOptions } from "./adapters/node-ws-server.js";
export { NodeWebSocketServer } from "./adapters/node-ws-server.js";
export { CURRENT_SCHEMA_VERSION, migrateSession } from "./adapters/state-migrator.js";
export type { StructuredLoggerOptions } from "./adapters/structured-logger.js";
export { LogLevel, StructuredLogger } from "./adapters/structured-logger.js";
export { CapabilitiesPolicy } from "./core/capabilities-policy.js";
export { DomainEventBus } from "./core/domain-event-bus.js";
export type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./core/interfaces/backend-adapter.js";
export type {
  DomainEvent,
  DomainEventMap,
  DomainEventSource,
  DomainEventType,
} from "./core/interfaces/domain-events.js";
export type {
  Configurable,
  Encryptable,
  Interruptible,
  PermissionHandler,
  PermissionRequestEvent,
  Reconnectable,
  TeamObserver,
} from "./core/interfaces/extensions.js";
export type { RegisterSessionInput, SessionRegistry } from "./core/interfaces/session-registry.js";
export type { ProcessSupervisorOptions, SupervisorEventMap } from "./core/process-supervisor.js";
export { ProcessSupervisor } from "./core/process-supervisor.js";
export { SessionBridge } from "./core/session-bridge.js";
export type { SessionCoordinatorOptions } from "./core/session-coordinator.js";
export { SessionCoordinator } from "./core/session-coordinator.js";
export type { LifecycleState } from "./core/session-lifecycle.js";
export { isLifecycleTransitionAllowed, LIFECYCLE_STATES } from "./core/session-lifecycle.js";
export { SessionRuntime } from "./core/session-runtime.js";
export { SimpleSessionRegistry } from "./core/simple-session-registry.js";
export type { SlashCommandResult } from "./core/slash-command-executor.js";
export { SlashCommandExecutor } from "./core/slash-command-executor.js";
export { TypedEventEmitter } from "./core/typed-emitter.js";
// Core types
export type {
  CoreSessionState,
  DevToolSessionState,
} from "./core/types/core-session-state.js";
export type { SequencedMessage } from "./core/types/sequenced-message.js";
// Team types
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
} from "./core/types/team-types.js";
export { isTeamMember, isTeamState, isTeamTask } from "./core/types/team-types.js";
// UnifiedMessage
export type {
  CodeContent,
  ImageContent,
  TextContent,
  ToolResultContent,
  ToolUseContent,
  UnifiedContent,
  UnifiedMessage,
  UnifiedMessageType,
} from "./core/types/unified-message.js";
export {
  canonicalize,
  createUnifiedMessage,
  isCodeContent,
  isImageContent,
  isTeamMessage,
  isTeamStateChange,
  isTeamTaskUpdate,
  isTextContent,
  isToolResultContent,
  isToolUseContent,
  isUnifiedMessage,
} from "./core/types/unified-message.js";
// Daemon
export type { CreateSessionOptions, DaemonSessionInfo } from "./daemon/child-process-supervisor.js";
export { ChildProcessSupervisor } from "./daemon/child-process-supervisor.js";
export type { ControlApiOptions } from "./daemon/control-api.js";
export { ControlApi } from "./daemon/control-api.js";
export type { DaemonOptions, Stoppable } from "./daemon/daemon.js";
export { Daemon } from "./daemon/daemon.js";
export { startHealthCheck } from "./daemon/health-check.js";
export { acquireLock, isLockStale, releaseLock } from "./daemon/lock-file.js";
export { registerSignalHandlers } from "./daemon/signal-handler.js";
export type { DaemonState } from "./daemon/state-file.js";
export { readState, updateHeartbeat, writeState } from "./daemon/state-file.js";
// Errors
export {
  BeamCodeError,
  errorMessage,
  ProcessError,
  StorageError,
  toBeamCodeError,
} from "./errors.js";
// HTTP
export type { HealthContext } from "./http/health.js";
// Interfaces
export type {
  AuthContext,
  Authenticator,
  ConsumerIdentity,
  ConsumerRole,
} from "./interfaces/auth.js";
export type { GitInfo, GitInfoResolver } from "./interfaces/git-resolver.js";
export type { Logger } from "./interfaces/logger.js";
export type {
  AggregatedError,
  AuthenticationFailedEvent,
  BackendConnectedEvent,
  BackendDisconnectedEvent,
  ConsumerConnectedEvent,
  ConsumerDisconnectedEvent,
  ErrorEvent,
  ErrorStats,
  LatencyEvent,
  MessageDroppedEvent,
  MessageReceivedEvent,
  MessageSentEvent,
  MetricsCollector,
  MetricsEvent,
  MetricsEventType,
  QueueDepthEvent,
  RateLimitExceededEvent,
  SendFailedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
} from "./interfaces/metrics.js";
export type { ProcessHandle, ProcessManager, SpawnOptions } from "./interfaces/process-manager.js";
export type { LauncherStateStorage, SessionStorage } from "./interfaces/storage.js";
export type { WebSocketLike } from "./interfaces/transport.js";
export type {
  OnCLIConnection,
  OnConsumerConnection,
  WebSocketServerLike,
} from "./interfaces/ws-server.js";
export { createAnonymousIdentity } from "./types/auth.js";
// Types
export type {
  CLIAssistantMessage,
  CLIAuthStatusMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIKeepAliveMessage,
  CLIMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  ContentBlock,
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionDestination,
  PermissionRequest,
  PermissionUpdate,
} from "./types/cli-messages.js";
export type { ProviderConfig, ResolvedConfig } from "./types/config.js";
export { DEFAULT_CONFIG, resolveConfig } from "./types/config.js";
export type { ConsumerMessage } from "./types/consumer-messages.js";
export type {
  BridgeEventMap,
  LauncherEventMap,
  SessionCoordinatorEventMap,
} from "./types/events.js";
export type { InboundMessage } from "./types/inbound-messages.js";
export type {
  InitializeCapabilities,
  LaunchOptions,
  PersistedSession,
  SessionInfo,
  SessionSnapshot,
  SessionState,
} from "./types/session-state.js";
export { stripAnsi } from "./utils/ansi-strip.js";
export { NDJSONLineBuffer, parseNDJSON, serializeNDJSON } from "./utils/ndjson.js";
export { NoopLogger, noopLogger } from "./utils/noop-logger.js";
// Utilities
export { RingBuffer } from "./utils/ring-buffer.js";
