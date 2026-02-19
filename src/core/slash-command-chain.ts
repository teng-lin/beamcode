import type { BridgeEventMap } from "../types/events.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { Session } from "./session-store.js";
import type { SlashCommandExecutor } from "./slash-command-executor.js";
import { commandName } from "./slash-command-executor.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandHandlerContext {
  command: string;
  requestId: string | undefined;
  session: Session;
}

export interface CommandHandler {
  readonly name: string;
  handles(ctx: CommandHandlerContext): boolean;
  execute(ctx: CommandHandlerContext): void;
}

// ─── SlashCommandChain ────────────────────────────────────────────────────────

export class SlashCommandChain {
  constructor(private readonly handlers: CommandHandler[]) {}

  dispatch(ctx: CommandHandlerContext): void {
    for (const handler of this.handlers) {
      if (handler.handles(ctx)) {
        handler.execute(ctx);
        return;
      }
    }
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────

type EmitEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

// ─── LocalHandler ─────────────────────────────────────────────────────────────

export interface LocalHandlerDeps {
  executor: SlashCommandExecutor;
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
}

export class LocalHandler implements CommandHandler {
  readonly name = "local";

  constructor(private deps: LocalHandlerDeps) {}

  handles(ctx: CommandHandlerContext): boolean {
    return commandName(ctx.command) === "/help";
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, session } = ctx;
    this.deps.executor
      .executeLocal(session.state, command, session.registry)
      .then((result) => {
        this.deps.broadcaster.broadcast(session, {
          type: "slash_command_result",
          command,
          request_id: requestId,
          content: result.content,
          source: result.source,
        });
        this.deps.emitEvent("slash_command:executed", {
          sessionId: session.id,
          command,
          source: result.source,
          durationMs: result.durationMs,
        });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        this.deps.broadcaster.broadcast(session, {
          type: "slash_command_error",
          command,
          request_id: requestId,
          error,
        });
        this.deps.emitEvent("slash_command:failed", {
          sessionId: session.id,
          command,
          error,
        });
      });
  }

  /** Call directly for the programmatic executeSlashCommand() path. */
  async executeLocal(ctx: CommandHandlerContext): Promise<{ content: string; source: "emulated" }> {
    const result = await this.deps.executor.executeLocal(
      ctx.session.state,
      ctx.command,
      ctx.session.registry,
    );
    return { content: result.content, source: result.source };
  }
}

// ─── AdapterNativeHandler ─────────────────────────────────────────────────────

export interface AdapterNativeHandlerDeps {
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
}

export class AdapterNativeHandler implements CommandHandler {
  readonly name = "adapter-native";

  constructor(private deps: AdapterNativeHandlerDeps) {}

  handles(ctx: CommandHandlerContext): boolean {
    return ctx.session.adapterSlashExecutor?.handles(ctx.command) ?? false;
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, session } = ctx;
    session
      .adapterSlashExecutor!.execute(command)
      .then((result) => {
        if (!result) return;
        this.deps.broadcaster.broadcast(session, {
          type: "slash_command_result",
          command,
          request_id: requestId,
          content: result.content,
          source: result.source,
        });
        this.deps.emitEvent("slash_command:executed", {
          sessionId: session.id,
          command,
          source: result.source,
          durationMs: result.durationMs,
        });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        this.deps.broadcaster.broadcast(session, {
          type: "slash_command_error",
          command,
          request_id: requestId,
          error,
        });
        this.deps.emitEvent("slash_command:failed", {
          sessionId: session.id,
          command,
          error,
        });
      });
  }
}

// ─── PassthroughHandler ───────────────────────────────────────────────────────

type SendUserMessage = (sessionId: string, content: string) => void;

export interface PassthroughHandlerDeps {
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
  sendUserMessage: SendUserMessage;
}

export class PassthroughHandler implements CommandHandler {
  readonly name = "passthrough";

  constructor(private deps: PassthroughHandlerDeps) {}

  handles(ctx: CommandHandlerContext): boolean {
    return ctx.session.adapterSupportsSlashPassthrough;
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, session } = ctx;
    session.pendingPassthroughs.push({ command: commandName(command), requestId });
    this.deps.sendUserMessage(session.id, command);
  }
}

// ─── UnsupportedHandler ───────────────────────────────────────────────────────

export interface UnsupportedHandlerDeps {
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
}

export class UnsupportedHandler implements CommandHandler {
  readonly name = "unsupported";

  constructor(private deps: UnsupportedHandlerDeps) {}

  handles(_ctx: CommandHandlerContext): boolean {
    return true; // terminal handler — always catches
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, session } = ctx;
    const name = commandName(command);
    const error = `${name} is not supported by the connected backend`;
    this.deps.broadcaster.broadcast(session, {
      type: "slash_command_error",
      command,
      request_id: requestId,
      error,
    });
    this.deps.emitEvent("slash_command:failed", {
      sessionId: session.id,
      command,
      error,
    });
  }
}
