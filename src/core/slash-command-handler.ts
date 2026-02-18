/**
 * SlashCommandHandler -- extracted from SessionBridge (Phase 2).
 *
 * Handles slash command routing: determines whether a command should be
 * forwarded to the CLI, executed locally, or reported as unknown.
 * SessionBridge delegates to this class while retaining the public API surface.
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

  /** Returns true if the command should be forwarded to the CLI as a user message (native, skill, or passthrough). */
  private shouldForwardToCLI(command: string, session: Session): boolean {
    return (
      this.executor.isNativeCommand(command, session.state) ||
      this.executor.isSkillCommand(command, session.registry) ||
      this.executor.isPassthroughCommand(command, session.registry)
    );
  }

  handleSlashCommand(
    session: Session,
    msg: { type: "slash_command"; command: string; request_id?: string },
  ): void {
    const { command, request_id } = msg;

    if (this.shouldForwardToCLI(command, session)) {
      this.sendUserMessage(session.id, command);
      return;
    }

    if (!this.executor.canHandle(command, session.state)) {
      const errorMsg = `Unknown slash command: ${command.split(/\s+/)[0]}`;
      this.broadcaster.broadcast(session, {
        type: "slash_command_error",
        command,
        request_id,
        error: errorMsg,
      });
      this.emitEvent("slash_command:failed", {
        sessionId: session.id,
        command,
        error: errorMsg,
      });
      return;
    }

    this.executor
      .execute(session.state, command, session.cliSessionId ?? session.id, session.registry)
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
  ): Promise<{ content: string; source: "emulated" | "pty" } | null> {
    if (this.shouldForwardToCLI(command, session)) {
      this.sendUserMessage(session.id, command);
      return null; // result comes back via normal CLI message flow
    }

    if (!this.executor.canHandle(command, session.state)) {
      return null;
    }

    const result = await this.executor.execute(
      session.state,
      command,
      session.cliSessionId ?? session.id,
      session.registry,
    );
    return { content: result.content, source: result.source };
  }
}
