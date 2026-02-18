/**
 * SlashCommandHandler -- extracted from SessionBridge (Phase 2).
 *
 * Binary routing: commands are either forwarded to the CLI or executed locally
 * (/help, /clear). All forwarded commands get echo interception via
 * pendingPassthrough so the bridge can capture the CLI response.
 */

import type { BridgeEventMap } from "../types/events.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { Session } from "./session-store.js";
import type { SlashCommandExecutor } from "./slash-command-executor.js";

// -- Dependency contracts ----------------------------------------------------

type ImageAttachment = { media_type: string; data: string };

type SendUserMessage = (
  sessionId: string,
  content: string,
  options?: {
    sessionIdOverride?: string;
    images?: ImageAttachment[];
  },
) => void;

type EmitEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

export interface SlashCommandHandlerDeps {
  executor: SlashCommandExecutor;
  broadcaster: ConsumerBroadcaster;
  sendUserMessage: SendUserMessage;
  emitEvent: EmitEvent;
}

// -- SlashCommandHandler -----------------------------------------------------

export class SlashCommandHandler {
  private executor: SlashCommandExecutor;
  private broadcaster: ConsumerBroadcaster;
  private sendUserMessage: SendUserMessage;
  private emitEvent: EmitEvent;

  constructor(deps: SlashCommandHandlerDeps) {
    this.executor = deps.executor;
    this.broadcaster = deps.broadcaster;
    this.sendUserMessage = deps.sendUserMessage;
    this.emitEvent = deps.emitEvent;
  }

  handleSlashCommand(
    session: Session,
    msg: { type: "slash_command"; command: string; request_id?: string },
  ): void {
    const { command, request_id } = msg;

    if (this.executor.shouldForwardToCLI(command)) {
      // ALL forwarded commands get echo interception (not just passthrough)
      session.pendingPassthrough = {
        command: command.trim().split(/\s+/)[0],
        requestId: request_id,
      };
      this.sendUserMessage(session.id, command);
      return;
    }

    // Local commands: /help, /clear
    this.executor
      .executeLocal(session.state, command, session.registry)
      .then((result) => {
        this.broadcaster.broadcast(session, {
          type: "slash_command_result",
          command,
          request_id,
          content: result.content,
          source: result.source,
        });
        this.emitEvent("slash_command:executed", {
          sessionId: session.id,
          command,
          source: result.source,
          durationMs: result.durationMs,
        });
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        this.broadcaster.broadcast(session, {
          type: "slash_command_error",
          command,
          request_id,
          error,
        });
        this.emitEvent("slash_command:failed", {
          sessionId: session.id,
          command,
          error,
        });
      });
  }

  /** Execute a slash command programmatically (no WebSocket needed). */
  async executeSlashCommand(
    session: Session,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    if (this.executor.shouldForwardToCLI(command)) {
      // ALL forwarded commands get echo interception
      session.pendingPassthrough = {
        command: command.trim().split(/\s+/)[0],
      };
      this.sendUserMessage(session.id, command);
      return null; // result comes back via normal CLI message flow
    }

    const result = await this.executor.executeLocal(session.state, command, session.registry);
    return { content: result.content, source: result.source };
  }
}
