import type WebSocket from "ws";
import type { AuthContext } from "../../interfaces/auth.js";
import type { Logger } from "../../interfaces/logger.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { WebSocketServerLike } from "../../interfaces/ws-server.js";
import type { SessionSnapshot, SessionState } from "../../types/session-state.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import type { SessionLauncher } from "../interfaces/session-launcher.js";
import type { AdapterResolver } from "./adapter-resolver.js";
import type { DomainEventMap } from "./domain-events.js";
import type { PolicyCommand } from "./runtime-commands.js";

export interface BridgeTransportPort {
  handleConsumerOpen(socket: WebSocketLike, context: AuthContext): void;
  handleConsumerMessage(socket: WebSocketLike, sessionId: string, data: string | Buffer): void;
  handleConsumerClose(socket: WebSocketLike, sessionId: string): void;
  setAdapterName(sessionId: string, name: string): void;
  connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void>;
}

export interface SessionTransportHub {
  setServer(server: WebSocketServerLike | null): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SessionTransportHubDeps {
  bridge: BridgeTransportPort;
  launcher: SessionLauncher;
  adapter: BackendAdapter | null;
  adapterResolver: AdapterResolver | null;
  logger: Logger;
  server: WebSocketServerLike | null;
  port: number;
  toAdapterSocket: (
    socket: WebSocketLike & {
      on(event: "message", handler: (data: string | Buffer) => void): void;
      on(event: "close", handler: () => void): void;
      on(event: "error", handler: (err: Error) => void): void;
    },
  ) => WebSocket;
}

export interface BridgeLifecyclePort {
  getAllSessions(): SessionState[];
  getSession(sessionId: string): SessionSnapshot | undefined;
  closeSession(sessionId: string): Promise<void>;
  applyPolicyCommand?(sessionId: string, command: PolicyCommand): void;
  broadcastWatchdogState(
    sessionId: string,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void;
}

export interface ReconnectController {
  start(): void;
  stop(): void;
}

export interface ReconnectControllerDeps {
  launcher: SessionLauncher;
  bridge: BridgeLifecyclePort;
  logger: Logger;
  reconnectGracePeriodMs: number;
  domainEvents?: {
    on<K extends keyof DomainEventMap & string>(
      event: K,
      listener: (domainEvent: DomainEventMap[K]) => void,
    ): unknown;
    off<K extends keyof DomainEventMap & string>(
      event: K,
      listener: (domainEvent: DomainEventMap[K]) => void,
    ): unknown;
  };
}

export interface IdleSessionReaper {
  start(): void;
  stop(): void;
}

export interface IdleSessionReaperDeps {
  bridge: BridgeLifecyclePort;
  logger: Logger;
  idleSessionTimeoutMs: number;
  domainEvents?: {
    on<K extends keyof DomainEventMap & string>(
      event: K,
      listener: (domainEvent: DomainEventMap[K]) => void,
    ): unknown;
    off<K extends keyof DomainEventMap & string>(
      event: K,
      listener: (domainEvent: DomainEventMap[K]) => void,
    ): unknown;
  };
}
