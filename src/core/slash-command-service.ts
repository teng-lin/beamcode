/**
 * SlashCommandService — entry point for slash command handling.
 *
 * Receives inbound `slash_command` messages from consumers and dispatches
 * them through the SlashCommandChain. Also provides a programmatic API
 * for executing commands without a WebSocket (used by the HTTP API).
 *
 * @module MessagePlane
 */

import type { InboundCommand } from "./interfaces/runtime-commands.js";
import type { MessageTracer } from "./message-tracer.js";
import type { Session } from "./session-repository.js";
import type {
  CommandHandlerContext,
  LocalHandler,
  SlashCommandChain,
} from "./slash-command-chain.js";

export interface SlashCommandServiceDeps {
  tracer: MessageTracer;
  now: () => number;
  generateTraceId: () => string;
  generateSlashRequestId: () => string;
  commandChain: Pick<SlashCommandChain, "dispatch">;
  localHandler: Pick<LocalHandler, "handles" | "executeLocal">;
}

export class SlashCommandService {
  constructor(private readonly deps: SlashCommandServiceDeps) {}

  handleInbound(session: Session, msg: Extract<InboundCommand, { type: "slash_command" }>): void {
    const slashRequestId = msg.request_id ?? this.deps.generateSlashRequestId();
    const traceId = this.deps.generateTraceId();
    this.deps.tracer.recv("bridge", "slash_command", msg, {
      sessionId: session.id,
      traceId,
      requestId: slashRequestId,
      command: msg.command,
      phase: "recv",
    });
    this.deps.commandChain.dispatch({
      command: msg.command,
      requestId: msg.request_id,
      slashRequestId,
      traceId,
      startedAtMs: this.deps.now(),
      session,
    });
  }

  async executeProgrammatic(
    session: Session,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    const ctx: CommandHandlerContext = {
      command,
      requestId: undefined,
      slashRequestId: this.deps.generateSlashRequestId(),
      traceId: this.deps.generateTraceId(),
      startedAtMs: this.deps.now(),
      session,
    };
    if (this.deps.localHandler.handles(ctx)) {
      return this.deps.localHandler.executeLocal(ctx);
    }
    this.deps.commandChain.dispatch(ctx);
    return null;
  }
}
