/**
 * CapabilitiesProtocol — extracted from SessionBridge.
 *
 * Manages the initialize handshake: sending the initialize control_request,
 * handling the control_response (success or error), applying capabilities to
 * session state, and cleaning up on timeout or cancellation.
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
import type { Session } from "./session-store.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── Dependency contracts ────────────────────────────────────────────────────

type SendToCLI = (session: Session, ndjson: string) => void;
type EmitEvent = (type: string, payload: unknown) => void;
type PersistSession = (session: Session) => void;

// ─── CapabilitiesProtocol ────────────────────────────────────────────────────

export class CapabilitiesProtocol {
  constructor(
    private config: ResolvedConfig,
    private logger: Logger,
    private sendToCLI: SendToCLI,
    private broadcaster: ConsumerBroadcaster,
    private emitEvent: EmitEvent,
    private persistSession: PersistSession,
  ) {}

  sendInitializeRequest(session: Session): void {
    if (session.pendingInitialize) return; // dedup
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (session.pendingInitialize?.requestId === requestId) {
        session.pendingInitialize = null;
        this.emitEvent("capabilities:timeout", { sessionId: session.id });
      }
    }, this.config.initializeTimeoutMs);
    session.pendingInitialize = { requestId, timer };
    this.sendToCLI(
      session,
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      }),
    );
  }

  cancelPendingInitialize(session: Session): void {
    if (session.pendingInitialize) {
      clearTimeout(session.pendingInitialize.timer);
      session.pendingInitialize = null;
    }
  }

  handleControlResponse(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Match against pending initialize request
    if (
      !session.pendingInitialize ||
      session.pendingInitialize.requestId !== (m.request_id as string)
    ) {
      return;
    }
    clearTimeout(session.pendingInitialize.timer);
    session.pendingInitialize = null;

    if (m.subtype === "error") {
      this.logger.warn(`Initialize failed: ${m.error}`);
      // Synthesize capabilities from session state (populated by session_init)
      // so consumers still receive capabilities_ready even when the CLI
      // refuses to re-initialize (e.g. "Already initialized").
      if (!session.state.capabilities && session.state.slash_commands.length > 0) {
        const commands = session.state.slash_commands.map((name: string) => ({
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
    session.state.capabilities = { commands, models, account, receivedAt: Date.now() };
    this.logger.info(
      `Capabilities received for session ${session.id}: ${commands.length} commands, ${models.length} models`,
    );

    if (commands.length > 0) {
      session.registry.registerFromCLI(commands);
    }

    this.broadcaster.broadcast(session, {
      type: "capabilities_ready",
      commands,
      models,
      account,
      skills: session.state.skills,
    });
    this.emitEvent("capabilities:ready", { sessionId: session.id, commands, models, account });
    this.persistSession(session);
  }
}
