// Core

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
export { CLILauncher } from "./core/cli-launcher.js";
export { SessionBridge } from "./core/session-bridge.js";
export { SessionManager } from "./core/session-manager.js";
export type { SlashCommandResult } from "./core/slash-command-executor.js";
export { SlashCommandExecutor } from "./core/slash-command-executor.js";
export { TypedEventEmitter } from "./core/typed-emitter.js";

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
