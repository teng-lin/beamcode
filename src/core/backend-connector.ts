/**
 * BackendConnector — BackendPlane lifecycle manager.
 *
 * Manages BackendAdapter sessions: connect, disconnect, send, and the async
 * message consumption loop. SessionBridge delegates backend operations here
 * while retaining the public API surface.
 *
 * Also handles slash-command passthrough: when a consumer sends a slash command
 * that the local registry cannot handle, BackendConnector intercepts the CLI's
 * response messages and routes them back as `slash_command_result` events.
 *
 * @module BackendPlane
 */

import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { CLIMessage } from "../types/cli-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import { CLI_ADAPTER_NAMES, type CliAdapterName } from "./interfaces/adapter-names.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter, BackendSession } from "./interfaces/backend-adapter.js";
import { type MessageTracer, noopTracer, type TraceOutcome } from "./message-tracer.js";
import type { Session } from "./session-repository.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// -- Dependency contracts ----------------------------------------------------

type EmitEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

export interface BackendConnectorDeps {
  adapter: BackendAdapter | null;
  adapterResolver: AdapterResolver | null;
  logger: Logger;
  metrics: MetricsCollector | null;
  broadcaster: ConsumerBroadcaster;
  routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  emitEvent: EmitEvent;
  onBackendConnectedState: (
    session: Session,
    params: {
      backendSession: BackendSession;
      backendAbort: AbortController;
      supportsSlashPassthrough: boolean;
      slashExecutor: Session["adapterSlashExecutor"] | null;
    },
  ) => void;
  onBackendDisconnectedState: (session: Session) => void;
  getBackendSession: (session: Session) => BackendSession | null;
  getBackendAbort: (session: Session) => AbortController | null;
  drainPendingMessages: (session: Session) => UnifiedMessage[];
  drainPendingPermissionIds: (session: Session) => string[];
  peekPendingPassthrough: (session: Session) => Session["pendingPassthroughs"][number] | undefined;
  shiftPendingPassthrough: (session: Session) => Session["pendingPassthroughs"][number] | undefined;
  setSlashCommandsState: (session: Session, commands: string[]) => void;
  registerCLICommands: (session: Session, commands: string[]) => void;
  tracer?: MessageTracer;
}

// -- BackendConnector -------------------------------------------------

export class BackendConnector {
  private adapter: BackendAdapter | null;
  private adapterResolver: AdapterResolver | null;
  private logger: Logger;
  private metrics: MetricsCollector | null;
  private broadcaster: ConsumerBroadcaster;
  private routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  private emitEvent: EmitEvent;
  private onBackendConnectedState: BackendConnectorDeps["onBackendConnectedState"];
  private onBackendDisconnectedState: BackendConnectorDeps["onBackendDisconnectedState"];
  private getBackendSession: BackendConnectorDeps["getBackendSession"];
  private getBackendAbort: BackendConnectorDeps["getBackendAbort"];
  private drainPendingMessages: BackendConnectorDeps["drainPendingMessages"];
  private drainPendingPermissionIds: BackendConnectorDeps["drainPendingPermissionIds"];
  private peekPendingPassthrough: BackendConnectorDeps["peekPendingPassthrough"];
  private shiftPendingPassthrough: BackendConnectorDeps["shiftPendingPassthrough"];
  private setSlashCommandsState: BackendConnectorDeps["setSlashCommandsState"];
  private registerCLICommands: BackendConnectorDeps["registerCLICommands"];
  private tracer: MessageTracer;
  private passthroughTextBuffers = new Map<string, string>();

  constructor(deps: BackendConnectorDeps) {
    this.adapter = deps.adapter;
    this.adapterResolver = deps.adapterResolver;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.broadcaster = deps.broadcaster;
    this.routeUnifiedMessage = deps.routeUnifiedMessage;
    this.emitEvent = deps.emitEvent;
    this.onBackendConnectedState = deps.onBackendConnectedState;
    this.onBackendDisconnectedState = deps.onBackendDisconnectedState;
    this.getBackendSession = deps.getBackendSession;
    this.getBackendAbort = deps.getBackendAbort;
    this.drainPendingMessages = deps.drainPendingMessages;
    this.drainPendingPermissionIds = deps.drainPendingPermissionIds;
    this.peekPendingPassthrough = deps.peekPendingPassthrough;
    this.shiftPendingPassthrough = deps.shiftPendingPassthrough;
    this.setSlashCommandsState = deps.setSlashCommandsState;
    this.registerCLICommands = deps.registerCLICommands;
    this.tracer = deps.tracer ?? noopTracer;
  }

  private supportsPassthroughHandler(session: BackendSession): session is BackendSession & {
    setPassthroughHandler: (handler: ((rawMsg: CLIMessage) => boolean) | null) => void;
  } {
    return (
      "setPassthroughHandler" in session && typeof session.setPassthroughHandler === "function"
    );
  }

  private cliUserEchoToText(content: unknown): string {
    if (typeof content === "string") return this.normalizeLocalCommandOutput(content);
    if (Array.isArray(content)) {
      return this.normalizeLocalCommandOutput(
        content
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
          .join(""),
      );
    }
    if (content && typeof content === "object" && "text" in content) {
      const text = (content as { text?: unknown }).text;
      return typeof text === "string" ? this.normalizeLocalCommandOutput(text) : "";
    }
    return "";
  }

  private normalizeLocalCommandOutput(text: string): string {
    const unwrapped = text
      .replace(/<local-command-stdout>/g, "")
      .replace(/<\/local-command-stdout>/g, "");
    return unwrapped.trim();
  }

  private unifiedSlashOutputToText(msg: UnifiedMessage): string {
    if (msg.type === "assistant") {
      return msg.content
        .filter((block) => block.type === "text")
        .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
        .join("");
    }
    if (msg.type === "result") {
      const result = msg.metadata.result;
      return typeof result === "string" ? result : "";
    }
    return "";
  }

  private streamEventTextChunk(msg: UnifiedMessage): string {
    if (msg.type !== "stream_event") return "";
    const event = msg.metadata.event;
    if (typeof event !== "object" || event === null) return "";
    const e = event as Record<string, unknown>;

    if (e.type === "content_block_delta") {
      const delta = e.delta;
      if (typeof delta !== "object" || delta === null) return "";
      const d = delta as Record<string, unknown>;
      if (typeof d.text === "string") return d.text;
      return "";
    }

    if (e.type === "content_block_start") {
      const block = e.content_block;
      if (typeof block !== "object" || block === null) return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      return "";
    }

    return "";
  }

  private annotateSlashTrace(
    msg: UnifiedMessage,
    pending: {
      slashRequestId: string;
      traceId: string;
      command: string;
    },
  ): void {
    msg.metadata.trace_id = pending.traceId;
    msg.metadata.slash_request_id = pending.slashRequestId;
    msg.metadata.slash_command = pending.command;
  }

  private emitSlashSummary(
    sessionId: string,
    pending: { slashRequestId: string; traceId: string; command: string; startedAtMs: number },
    outcome: TraceOutcome,
    matchedPath: "assistant_text" | "result_field" | "stream_buffer" | "none",
    reasons: string[] = [],
  ): void {
    this.tracer.send(
      "bridge",
      "slash_decision_summary",
      {
        matched_path: matchedPath,
        drop_or_consume_reasons: reasons,
        timings: {
          total_ms: Math.max(0, Date.now() - pending.startedAtMs),
        },
      },
      {
        sessionId,
        traceId: pending.traceId,
        requestId: pending.slashRequestId,
        command: pending.command,
        phase: "summary",
        outcome,
      },
    );
  }

  private applyBackendConnectedState(
    session: Session,
    params: {
      backendSession: BackendSession;
      backendAbort: AbortController;
      supportsSlashPassthrough: boolean;
      slashExecutor: Session["adapterSlashExecutor"] | null;
    },
  ): void {
    this.onBackendConnectedState(session, params);
  }

  private applyBackendDisconnectedState(session: Session): void {
    this.onBackendDisconnectedState(session);
  }

  private getBackendSessionRef(session: Session): BackendSession | null {
    return this.getBackendSession(session);
  }

  private getBackendAbortController(session: Session): AbortController | null {
    return this.getBackendAbort(session);
  }

  private applySlashCommandsState(session: Session, commands: string[]): void {
    this.setSlashCommandsState(session, commands);
  }

  private applySlashRegistryCommands(session: Session, commands: string[]): void {
    this.registerCLICommands(session, commands);
  }

  private drainPendingMessagesQueue(session: Session): UnifiedMessage[] {
    return this.drainPendingMessages(session);
  }

  private drainPendingPermissionRequestIds(session: Session): string[] {
    return this.drainPendingPermissionIds(session);
  }

  private peekPendingPassthroughEntry(
    session: Session,
  ): Session["pendingPassthroughs"][number] | undefined {
    return this.peekPendingPassthrough(session);
  }

  private shiftPendingPassthroughEntry(
    session: Session,
  ): Session["pendingPassthroughs"][number] | undefined {
    return this.shiftPendingPassthrough(session);
  }

  private maybeEmitPendingPassthroughFromUnified(session: Session, msg: UnifiedMessage): void {
    const pending = this.peekPendingPassthroughEntry(session);
    if (!pending) {
      this.passthroughTextBuffers.delete(session.id);
      return;
    }

    // Only annotate messages that are part of the passthrough response flow
    // (stream chunks, assistant, result). Other messages (e.g., concurrent
    // permission requests) should not be contaminated with slash trace context.
    const isPassthroughRelevant =
      msg.type === "stream_event" || msg.type === "assistant" || msg.type === "result";
    if (isPassthroughRelevant) {
      this.annotateSlashTrace(msg, pending);
    }

    const streamChunk = this.streamEventTextChunk(msg);
    if (streamChunk) {
      const current = this.passthroughTextBuffers.get(session.id) ?? "";
      // Keep a bounded buffer per session to avoid unbounded growth.
      this.passthroughTextBuffers.set(session.id, `${current}${streamChunk}`.slice(-50_000));
      return;
    }

    let content = this.unifiedSlashOutputToText(msg);
    let matchedPath: "assistant_text" | "result_field" | "stream_buffer" | "none" = "none";
    if (msg.type === "assistant" && content) matchedPath = "assistant_text";
    if (msg.type === "result" && content) matchedPath = "result_field";
    if (!content && msg.type === "result") {
      content = this.passthroughTextBuffers.get(session.id) ?? "";
      if (content) matchedPath = "stream_buffer";
    }
    if (!content) {
      if (msg.type === "result") {
        this.shiftPendingPassthroughEntry(session);
        this.passthroughTextBuffers.delete(session.id);
        const error = `Pending passthrough "${pending.command}" produced empty output`;
        this.broadcaster.broadcast(session, {
          type: "slash_command_error",
          command: pending.command,
          request_id: pending.requestId,
          error,
        });
        this.emitEvent("slash_command:failed", {
          sessionId: session.id,
          command: pending.command,
          error,
        });
        this.tracer.error("bridge", "slash_command_error", error, {
          sessionId: session.id,
          traceId: pending.traceId,
          requestId: pending.slashRequestId,
          command: pending.command,
          action: "pending_passthrough_empty_result",
          phase: "finalize_passthrough",
          outcome: "empty_result",
        });
        this.emitSlashSummary(session.id, pending, "empty_result", "none", [
          "pending_passthrough_empty_result",
        ]);
      }
      return;
    }

    this.shiftPendingPassthroughEntry(session);
    this.passthroughTextBuffers.delete(session.id);
    this.broadcaster.broadcast(session, {
      type: "slash_command_result",
      command: pending.command,
      request_id: pending.requestId,
      content,
      source: "cli",
    });
    this.tracer.send(
      "bridge",
      "slash_command_result",
      { command: pending.command },
      {
        sessionId: session.id,
        traceId: pending.traceId,
        requestId: pending.slashRequestId,
        command: pending.command,
        phase: "finalize_passthrough",
        outcome: "success",
      },
    );
    this.emitEvent("slash_command:executed", {
      sessionId: session.id,
      command: pending.command,
      source: "cli",
      durationMs: 0,
    });
    this.emitSlashSummary(session.id, pending, "success", matchedPath);
  }

  /** Whether a BackendAdapter is configured. */
  get hasAdapter(): boolean {
    return this.adapter !== null || this.adapterResolver !== null;
  }

  /** Resolve the adapter for a session, falling back to the global adapter. */
  private resolveAdapter(session: Session): BackendAdapter | null {
    if (session.adapterName && this.adapterResolver) {
      // Validate adapter name before resolving (defends against corrupted persisted data)
      if (!CLI_ADAPTER_NAMES.includes(session.adapterName as CliAdapterName)) {
        this.logger.warn(
          `Invalid adapter name "${session.adapterName}" on session ${session.id}, falling back to global`,
        );
        return this.adapter;
      }
      return this.adapterResolver.resolve(session.adapterName as CliAdapterName);
    }
    return this.adapter;
  }

  /** Connect a session via BackendAdapter and start consuming messages. */
  async connectBackend(
    session: Session,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    const adapter = this.resolveAdapter(session);
    if (!adapter) {
      throw new Error("No BackendAdapter configured");
    }

    // Close any existing backend session
    const existingSession = this.getBackendSessionRef(session);
    if (existingSession) {
      this.getBackendAbortController(session)?.abort();
      await existingSession.close().catch((err) => {
        this.logger.warn("Failed to close backend session", { sessionId: session.id, error: err });
      });
    }

    const backendSession = await adapter.connect({
      sessionId: session.id,
      resume: options?.resume,
      adapterOptions: { ...options?.adapterOptions, tracer: this.tracer },
    });

    // Set up adapter-specific slash executor (e.g. Codex -> JSON-RPC translation)
    let slashExecutor: Session["adapterSlashExecutor"] | null = null;
    if (adapter.createSlashExecutor) {
      const executor = adapter.createSlashExecutor(backendSession);
      if (executor) {
        slashExecutor = executor;
        const commands = executor.supportedCommands();
        this.applySlashCommandsState(session, commands);
        this.applySlashRegistryCommands(session, commands);
      }
    }

    if (this.supportsPassthroughHandler(backendSession)) {
      backendSession.setPassthroughHandler((rawMsg) => {
        if (rawMsg.type !== "user") return false;
        const pending = this.shiftPendingPassthroughEntry(session);
        if (!pending) return false;
        this.passthroughTextBuffers.delete(session.id);

        const content = this.cliUserEchoToText(rawMsg.message.content);
        this.broadcaster.broadcast(session, {
          type: "slash_command_result",
          command: pending.command,
          request_id: pending.requestId,
          content,
          source: "cli",
        });
        this.tracer.send(
          "bridge",
          "slash_command_result",
          { command: pending.command },
          {
            sessionId: session.id,
            traceId: pending.traceId,
            requestId: pending.slashRequestId,
            command: pending.command,
            phase: "intercept_user_echo",
            outcome: "intercepted_user_echo",
          },
        );
        this.emitEvent("slash_command:executed", {
          sessionId: session.id,
          command: pending.command,
          source: "cli",
          durationMs: 0,
        });
        this.emitSlashSummary(session.id, pending, "intercepted_user_echo", "assistant_text");
        return true;
      });
    }

    const abort = new AbortController();
    this.applyBackendConnectedState(session, {
      backendSession,
      backendAbort: abort,
      supportsSlashPassthrough: adapter.capabilities.slashCommands,
      slashExecutor,
    });

    this.logger.info(`Backend connected for session ${session.id} via ${adapter.name}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "backend:connected",
      sessionId: session.id,
    });
    this.broadcaster.broadcast(session, { type: "cli_connected" });
    this.emitEvent("backend:connected", { sessionId: session.id });

    // Flush any pending messages
    const pendingMessages = this.drainPendingMessagesQueue(session);
    if (pendingMessages.length > 0) {
      this.logger.info(
        `Flushing ${pendingMessages.length} queued message(s) for session ${session.id}`,
      );
      for (const msg of pendingMessages) {
        backendSession.send(msg);
      }
    }

    // Start consuming backend messages in the background
    this.startBackendConsumption(session, abort.signal);
  }

  /** Disconnect the backend session. */
  async disconnectBackend(session: Session): Promise<void> {
    const backendSession = this.getBackendSessionRef(session);
    if (!backendSession) return;

    this.getBackendAbortController(session)?.abort();
    await backendSession.close().catch((err) => {
      this.logger.warn("Failed to close backend session", { sessionId: session.id, error: err });
    });
    this.applyBackendDisconnectedState(session);
    this.passthroughTextBuffers.delete(session.id);

    this.logger.info(`Backend disconnected for session ${session.id}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "backend:disconnected",
      sessionId: session.id,
    });
    this.broadcaster.broadcast(session, { type: "cli_disconnected" });
    this.emitEvent("backend:disconnected", {
      sessionId: session.id,
      code: 1000,
      reason: "normal",
    });

    this.cancelPendingPermissions(session);
  }

  /** Whether a backend session is connected for a given session. */
  isBackendConnected(session: Session): boolean {
    return this.getBackendSessionRef(session) !== null;
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(session: Session, message: UnifiedMessage): void {
    const backendSession = this.getBackendSessionRef(session);
    if (!backendSession) {
      this.logger.warn(`No backend session for ${session.id}, cannot send message`);
      return;
    }
    try {
      backendSession.send(message);
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
    const reqIds = this.drainPendingPermissionRequestIds(session);
    for (const reqId of reqIds) {
      this.broadcaster.broadcastToParticipants(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
  }

  /** Consume backend messages in the background. */
  private startBackendConsumption(session: Session, signal: AbortSignal): void {
    const sessionId = session.id;

    // Consume in the background -- don't await
    void (async () => {
      try {
        const backendSession = this.getBackendSessionRef(session);
        if (!backendSession) return;
        for await (const msg of backendSession.messages) {
          if (signal.aborted) break;
          this.emitEvent("backend:message", { sessionId, message: msg });
          // Some CLI versions return slash command output as regular assistant/result
          // messages without a user-echo. Convert that first textual response into a
          // slash_command_result so passthrough commands remain reliable.
          this.maybeEmitPendingPassthroughFromUnified(session, msg);
          this.routeUnifiedMessage(session, msg);
        }
      } catch (err) {
        if (signal.aborted) return; // expected shutdown
        this.logger.error(`Backend message stream error for session ${sessionId}`, { error: err });
        const errorMsg = err instanceof Error ? err.message : String(err);
        while (true) {
          const pending = this.shiftPendingPassthroughEntry(session);
          if (!pending) break;
          this.broadcaster.broadcast(session, {
            type: "slash_command_error",
            command: pending.command,
            request_id: pending.requestId,
            error: errorMsg,
          });
          this.emitEvent("slash_command:failed", {
            sessionId,
            command: pending.command,
            error: errorMsg,
          });
          this.emitSlashSummary(sessionId, pending, "backend_error", "none", [errorMsg]);
        }
        this.emitEvent("error", {
          source: "backendConsumption",
          error: err instanceof Error ? err : new Error(String(err)),
          sessionId,
        });
      }

      // Stream ended -- backend disconnected (unless we aborted intentionally)
      if (!signal.aborted) {
        while (true) {
          const pending = this.shiftPendingPassthroughEntry(session);
          if (!pending) break;
          this.broadcaster.broadcast(session, {
            type: "slash_command_error",
            command: pending.command,
            request_id: pending.requestId,
            error: "Backend stream ended unexpectedly",
          });
          this.emitEvent("slash_command:failed", {
            sessionId,
            command: pending.command,
            error: "Backend stream ended unexpectedly",
          });
          this.emitSlashSummary(sessionId, pending, "backend_error", "none", ["stream ended"]);
        }
        this.applyBackendDisconnectedState(session);
        this.passthroughTextBuffers.delete(session.id);
        this.broadcaster.broadcast(session, { type: "cli_disconnected" });
        this.emitEvent("backend:disconnected", {
          sessionId,
          code: 1000,
          reason: "stream ended",
        });
        this.cancelPendingPermissions(session);
      }
    })();
  }
}
