/**
 * BackendLifecycleManager -- extracted from SessionBridge (Phase 2).
 *
 * Manages the lifecycle of BackendAdapter sessions: connect, disconnect,
 * send, and the async message consumption loop. SessionBridge delegates
 * to this class while retaining the public API surface.
 */

import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { CLIMessage } from "../types/cli-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { BackendAdapter, BackendSession } from "./interfaces/backend-adapter.js";
import type { Session } from "./session-store.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// -- Dependency contracts ----------------------------------------------------

type EmitEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

export interface BackendLifecycleDeps {
  adapter: BackendAdapter | null;
  logger: Logger;
  metrics: MetricsCollector | null;
  broadcaster: ConsumerBroadcaster;
  routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  emitEvent: EmitEvent;
}

// -- BackendLifecycleManager -------------------------------------------------

export class BackendLifecycleManager {
  private adapter: BackendAdapter | null;
  private logger: Logger;
  private metrics: MetricsCollector | null;
  private broadcaster: ConsumerBroadcaster;
  private routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  private emitEvent: EmitEvent;

  constructor(deps: BackendLifecycleDeps) {
    this.adapter = deps.adapter;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.broadcaster = deps.broadcaster;
    this.routeUnifiedMessage = deps.routeUnifiedMessage;
    this.emitEvent = deps.emitEvent;
  }

  private supportsPassthroughHandler(session: BackendSession): session is BackendSession & {
    setPassthroughHandler: (handler: ((rawMsg: CLIMessage) => boolean) | null) => void;
  } {
    return (
      "setPassthroughHandler" in session && typeof session.setPassthroughHandler === "function"
    );
  }

  private cliUserEchoToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") return item;
          if (
            item &&
            typeof item === "object" &&
            "type" in item &&
            (item as { type?: string }).type === "text" &&
            "text" in item &&
            typeof (item as { text?: unknown }).text === "string"
          ) {
            return (item as { text: string }).text;
          }
          return "";
        })
        .join("");
    }
    if (content && typeof content === "object" && "text" in content) {
      const text = (content as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    return "";
  }

  /** Whether a BackendAdapter is configured. */
  get hasAdapter(): boolean {
    return this.adapter !== null;
  }

  /** Connect a session via BackendAdapter and start consuming messages. */
  async connectBackend(
    session: Session,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.adapter) {
      throw new Error("No BackendAdapter configured");
    }

    // Close any existing backend session
    if (session.backendSession) {
      session.backendAbort?.abort();
      await session.backendSession.close().catch(() => {});
    }

    const backendSession = await this.adapter.connect({
      sessionId: session.id,
      resume: options?.resume,
      adapterOptions: options?.adapterOptions,
    });

    session.backendSession = backendSession;

    // Set up adapter-specific slash executor (e.g. Codex → JSON-RPC translation)
    session.adapterSlashExecutor = null;
    if (this.adapter.name === "codex") {
      try {
        // Dynamic imports to avoid static core/ → adapters/codex/ dependency.
        // @ts-expect-error -- intentional cross-layer dynamic import
        const codexSlashMod = await import("../../adapters/codex/codex-slash-executor.js");
        // @ts-expect-error -- intentional cross-layer dynamic import
        const codexSessionMod = await import("../../adapters/codex/codex-session.js");
        if (backendSession instanceof codexSessionMod.CodexSession) {
          const executor = new codexSlashMod.CodexSlashExecutor(backendSession);
          session.adapterSlashExecutor = executor;
          const commands = executor.supportedCommands();
          session.state.slash_commands = commands;
          session.registry.registerFromCLI(
            commands.map((name: string) => ({ name, description: "" })),
          );
        }
      } catch (err) {
        this.logger.warn("Failed to set up Codex slash executor", { error: err });
      }
    }

    if (this.supportsPassthroughHandler(backendSession)) {
      backendSession.setPassthroughHandler((rawMsg) => {
        if (rawMsg.type !== "user") return false;
        const pending = session.pendingPassthrough;
        if (!pending) return false;

        const content = this.cliUserEchoToText(rawMsg.message.content);
        this.broadcaster.broadcast(session, {
          type: "slash_command_result",
          command: pending.command,
          request_id: pending.requestId,
          content,
          source: "cli",
        });
        this.emitEvent("slash_command:executed", {
          sessionId: session.id,
          command: pending.command,
          source: "cli",
          durationMs: 0,
        });
        session.pendingPassthrough = null;
        return true;
      });
    }

    const abort = new AbortController();
    session.backendAbort = abort;

    this.logger.info(`Backend connected for session ${session.id} via ${this.adapter.name}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:connected",
      sessionId: session.id,
    });
    this.broadcaster.broadcast(session, { type: "cli_connected" });
    this.emitEvent("backend:connected", { sessionId: session.id });
    this.emitEvent("cli:connected", { sessionId: session.id });

    // Flush any pending messages
    if (session.pendingMessages.length > 0) {
      this.logger.info(
        `Flushing ${session.pendingMessages.length} queued message(s) for session ${session.id}`,
      );
      for (const ndjson of session.pendingMessages) {
        try {
          session.backendSession.sendRaw(ndjson);
        } catch {
          // Adapter doesn't support raw NDJSON -- all remaining messages will
          // also fail, so drop them. Direct-connection adapters (Codex, ACP)
          // connect before consumers send messages, so this rarely triggers.
          this.logger.warn(
            `Dropping ${session.pendingMessages.length} queued NDJSON message(s) for session ${session.id}: adapter does not support sendRaw`,
          );
          break;
        }
      }
      session.pendingMessages = [];
    }

    // Start consuming backend messages in the background
    this.startBackendConsumption(session, abort.signal);
  }

  /** Disconnect the backend session. */
  async disconnectBackend(session: Session): Promise<void> {
    if (!session.backendSession) return;

    session.backendAbort?.abort();
    await session.backendSession.close().catch(() => {});
    session.backendSession = null;
    session.backendAbort = null;

    this.logger.info(`Backend disconnected for session ${session.id}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:disconnected",
      sessionId: session.id,
    });
    this.broadcaster.broadcast(session, { type: "cli_disconnected" });
    this.emitEvent("backend:disconnected", {
      sessionId: session.id,
      code: 1000,
      reason: "normal",
    });
    this.emitEvent("cli:disconnected", { sessionId: session.id });

    this.cancelPendingPermissions(session);
  }

  /** Whether a backend session is connected for a given session. */
  isBackendConnected(session: Session): boolean {
    return !!session.backendSession;
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(session: Session, message: UnifiedMessage): void {
    if (!session.backendSession) {
      this.logger.warn(`No backend session for ${session.id}, cannot send message`);
      return;
    }
    try {
      session.backendSession.send(message);
    } catch (err) {
      this.logger.error(`Failed to send to backend for session ${session.id}`, { error: err });
      this.emitEvent("error", {
        source: "sendToBackend",
        error: err instanceof Error ? err : new Error(String(err)),
        sessionId: session.id,
      });
    }
  }

  /** Cancel all pending permission requests and notify consumers. */
  private cancelPendingPermissions(session: Session): void {
    for (const [reqId] of session.pendingPermissions) {
      this.broadcaster.broadcastToParticipants(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
    session.pendingPermissions.clear();
  }

  /** Consume backend messages in the background. */
  private startBackendConsumption(session: Session, signal: AbortSignal): void {
    const sessionId = session.id;

    // Consume in the background -- don't await
    (async () => {
      try {
        if (!session.backendSession) return;
        for await (const msg of session.backendSession.messages) {
          if (signal.aborted) break;
          session.lastActivity = Date.now();
          this.routeUnifiedMessage(session, msg);
        }
      } catch (err) {
        if (signal.aborted) return; // expected shutdown
        this.logger.error(`Backend message stream error for session ${sessionId}`, { error: err });
        this.emitEvent("error", {
          source: "backendConsumption",
          error: err instanceof Error ? err : new Error(String(err)),
          sessionId,
        });
      }

      // Stream ended -- backend disconnected (unless we aborted intentionally)
      if (!signal.aborted) {
        session.backendSession = null;
        session.backendAbort = null;
        this.broadcaster.broadcast(session, { type: "cli_disconnected" });
        this.emitEvent("backend:disconnected", {
          sessionId,
          code: 1000,
          reason: "stream ended",
        });
        this.emitEvent("cli:disconnected", { sessionId });

        this.cancelPendingPermissions(session);
      }
    })();
  }
}
