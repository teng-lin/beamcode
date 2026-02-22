/**
 * CapabilitiesPolicy — SessionControl initialize handshake manager.
 *
 * Manages the initialize handshake: sending the `initialize` control_request,
 * handling the control_response (success or error), applying capabilities to
 * session state, and cleaning up on timeout or cancellation.
 *
 * Capabilities (commands, models, account info) are discovered at connect time
 * and broadcast to all consumers via `capabilities_ready`.
 *
 * @module SessionControl
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "../interfaces/logger.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ResolvedConfig } from "../types/config.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { Session } from "./session-repository.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── Dependency contracts ────────────────────────────────────────────────────

type EmitEvent = (type: string, payload: unknown) => void;
type PersistSession = (session: Session) => void;
type CapabilitiesStateAccessors = {
  getState: (session: Session) => Session["state"];
  setState: (session: Session, state: Session["state"]) => void;
  getPendingInitialize: (session: Session) => Session["pendingInitialize"];
  setPendingInitialize: (session: Session, pendingInitialize: Session["pendingInitialize"]) => void;
  trySendRawToBackend: (session: Session, ndjson: string) => "sent" | "unsupported" | "no_backend";
  registerCLICommands: (session: Session, commands: InitializeCommand[]) => void;
};

// ─── CapabilitiesPolicy ─────────────────────────────────────────────────────

export class CapabilitiesPolicy {
  private readonly stateAccessors: CapabilitiesStateAccessors;

  constructor(
    private config: ResolvedConfig,
    private logger: Logger,
    private broadcaster: ConsumerBroadcaster,
    private emitEvent: EmitEvent,
    private persistSession: PersistSession,
    stateAccessors: CapabilitiesStateAccessors,
  ) {
    this.stateAccessors = stateAccessors;
  }

  private getState(session: Session): Session["state"] {
    return this.stateAccessors.getState(session);
  }

  private setState(session: Session, state: Session["state"]): void {
    this.stateAccessors.setState(session, state);
  }

  private getPendingInitialize(session: Session): Session["pendingInitialize"] {
    return this.stateAccessors.getPendingInitialize(session);
  }

  private setPendingInitialize(
    session: Session,
    pendingInitialize: Session["pendingInitialize"],
  ): void {
    this.stateAccessors.setPendingInitialize(session, pendingInitialize);
  }

  private trySendRawToBackend(
    session: Session,
    ndjson: string,
  ): "sent" | "unsupported" | "no_backend" {
    return this.stateAccessors.trySendRawToBackend(session, ndjson);
  }

  private registerCLICommands(session: Session, commands: InitializeCommand[]): void {
    this.stateAccessors.registerCLICommands(session, commands);
  }

  sendInitializeRequest(session: Session): void {
    if (this.getPendingInitialize(session)) return; // dedup
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (this.getPendingInitialize(session)?.requestId === requestId) {
        this.setPendingInitialize(session, null);
        this.emitEvent("capabilities:timeout", { sessionId: session.id });
      }
    }, this.config.initializeTimeoutMs);
    this.setPendingInitialize(session, { requestId, timer });

    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "initialize" },
    });

    if (this.trySendRawToBackend(session, ndjson) === "unsupported") {
      // Adapter doesn't support raw NDJSON (e.g. Codex) -- cancel the
      // initialize request. Capabilities arrive via the init response instead.
      this.logger.info(
        `Skipping NDJSON initialize for session ${session.id}: adapter does not support sendRaw`,
      );
      clearTimeout(timer);
      this.setPendingInitialize(session, null);
    }
  }

  cancelPendingInitialize(session: Session): void {
    const pendingInitialize = this.getPendingInitialize(session);
    if (pendingInitialize) {
      clearTimeout(pendingInitialize.timer);
      this.setPendingInitialize(session, null);
    }
  }

  handleControlResponse(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Match against pending initialize request
    const pendingInitialize = this.getPendingInitialize(session);
    if (!pendingInitialize || pendingInitialize.requestId !== (m.request_id as string)) {
      return;
    }
    clearTimeout(pendingInitialize.timer);
    this.setPendingInitialize(session, null);

    if (m.subtype === "error") {
      this.logger.warn(`Initialize failed: ${m.error}`);
      // Synthesize capabilities from session state (populated by session_init)
      // so consumers still receive capabilities_ready even when the CLI
      // refuses to re-initialize (e.g. "Already initialized").
      const state = this.getState(session);
      if (!state.capabilities && state.slash_commands.length > 0) {
        const commands = state.slash_commands.map((name: string) => ({
          name,
          description: "",
        }));
        this.applyCapabilities(session, commands, [], null);
      }
      return;
    }

    const response = m.response as
      | { commands?: unknown[]; models?: unknown[]; account?: unknown }
      | undefined;
    if (!response) return;

    const commands = Array.isArray(response.commands)
      ? (response.commands as InitializeCommand[])
      : [];
    const models = Array.isArray(response.models) ? (response.models as InitializeModel[]) : [];
    const account = (response.account as InitializeAccount | null) ?? null;

    this.applyCapabilities(session, commands, models, account);
  }

  applyCapabilities(
    session: Session,
    commands: InitializeCommand[],
    models: InitializeModel[],
    account: InitializeAccount | null,
  ): void {
    const state = this.getState(session);
    this.setState(session, {
      ...state,
      capabilities: { commands, models, account, receivedAt: Date.now() },
    });
    this.logger.info(
      `Capabilities received for session ${session.id}: ${commands.length} commands, ${models.length} models`,
    );

    if (commands.length > 0) {
      this.registerCLICommands(session, commands);
    }

    this.broadcaster.broadcast(session, {
      type: "capabilities_ready",
      commands,
      models,
      account,
      skills: this.getState(session).skills,
    });
    this.emitEvent("capabilities:ready", { sessionId: session.id, commands, models, account });
    this.persistSession(session);
  }
}
