// Core interfaces

// Adapters
export { ConsoleLogger } from "./adapters/console-logger.js";
export { ConsoleMetricsCollector } from "./adapters/console-metrics-collector.js";
export { DefaultGitResolver } from "./adapters/default-git-resolver.js";
export { FileStorage } from "./adapters/file-storage.js";
export { MemoryStorage } from "./adapters/memory-storage.js";
export { NodeProcessManager } from "./adapters/node-process-manager.js";
export type { NodeWebSocketServerOptions } from "./adapters/node-ws-server.js";
export { NodeWebSocketServer } from "./adapters/node-ws-server.js";
export { NoopLogger } from "./adapters/noop-logger.js";
export { PtyCommandRunner } from "./adapters/pty-command-runner.js";
export type { SdkUrlLauncherOptions } from "./adapters/sdk-url/sdk-url-launcher.js";
export { SdkUrlLauncher } from "./adapters/sdk-url/sdk-url-launcher.js";
// State migration
export { CURRENT_SCHEMA_VERSION, migrateSession } from "./adapters/state-migrator.js";
export type { StructuredLoggerOptions } from "./adapters/structured-logger.js";
// Structured logging
export { LogLevel, StructuredLogger } from "./adapters/structured-logger.js";
export { CLILauncher } from "./core/cli-launcher.js";
export type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./core/interfaces/backend-adapter.js";
export type {
  Configurable,
  Encryptable,
  Interruptible,
  PermissionHandler,
  PermissionRequestEvent,
  Reconnectable,
  TeamObserver,
} from "./core/interfaces/extensions.js";
export type { ProcessSupervisorOptions, SupervisorEventMap } from "./core/process-supervisor.js";
export { ProcessSupervisor } from "./core/process-supervisor.js";
export { SessionBridge } from "./core/session-bridge.js";
export { SessionManager } from "./core/session-manager.js";
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
// Interfaces
export type {
  AuthContext,
  Authenticator,
  ConsumerIdentity,
  ConsumerRole,
} from "./interfaces/auth.js";
export type { CommandRunner, CommandRunnerResult } from "./interfaces/command-runner.js";
export type { GitInfo, GitInfoResolver } from "./interfaces/git-resolver.js";
export type { Logger } from "./interfaces/logger.js";
export type {
  CLIConnectedEvent,
  CLIDisconnectedEvent,
  ConsumerConnectedEvent,
  ConsumerDisconnectedEvent,
  ErrorEvent,
  MetricsCollector,
  MetricsEvent,
  MetricsEventType,
  RateLimitExceededEvent,
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
  SessionManagerEventMap,
} from "./types/events.js";
export type { InboundMessage } from "./types/inbound-messages.js";
export type {
  InitializeCapabilities,
  LaunchOptions,
  PersistedSession,
  SdkSessionInfo,
  SessionSnapshot,
  SessionState,
} from "./types/session-state.js";

// Utilities
export { stripAnsi } from "./utils/ansi-strip.js";
export { NDJSONLineBuffer, parseNDJSON, serializeNDJSON } from "./utils/ndjson.js";
