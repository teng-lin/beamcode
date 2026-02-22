/**
 * SlashCommandChain — chain-of-responsibility dispatcher for slash commands.
 *
 * Routes incoming slash commands through an ordered chain of handlers:
 * 1. **LocalHandler** — handles `/help` locally (no CLI needed)
 * 2. **AdapterNativeHandler** — handles commands via adapter-specific executor
 * 3. **PassthroughHandler** — forwards commands to the CLI as user messages
 * 4. **UnsupportedHandler** — terminal fallback for unrecognized commands
 *
 * @module MessagePlane
 */

import type { BridgeEventMap } from "../types/events.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import { type MessageTracer, noopTracer, type TraceOutcome } from "./message-tracer.js";
import type { Session } from "./session-repository.js";
import type { SlashCommandExecutor } from "./slash-command-executor.js";
import { commandName } from "./slash-command-executor.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandHandlerContext {
  command: string;
  requestId: string | undefined;
  slashRequestId: string;
  traceId: string;
  startedAtMs: number;
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
  tracer?: MessageTracer;
}

export class LocalHandler implements CommandHandler {
  readonly name = "local";
  private readonly tracer: MessageTracer;

  constructor(private deps: LocalHandlerDeps) {
    this.tracer = deps.tracer ?? noopTracer;
  }

  handles(ctx: CommandHandlerContext): boolean {
    return commandName(ctx.command) === "/help";
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, slashRequestId, traceId, startedAtMs, session } = ctx;
    this.tracer.recv(
      "bridge",
      "slash_command",
      { command },
      {
        sessionId: session.id,
        traceId,
        requestId: slashRequestId,
        command,
        phase: "dispatch_local",
      },
    );
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
        emitSlashSummary(this.tracer, {
          sessionId: session.id,
          traceId,
          requestId: slashRequestId,
          command,
          startedAtMs,
          outcome: "success",
          matchedPath: "result_field",
          reasons: [],
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
        emitSlashSummary(this.tracer, {
          sessionId: session.id,
          traceId,
          requestId: slashRequestId,
          command,
          startedAtMs,
          outcome: "backend_error",
          matchedPath: "none",
          reasons: [error],
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
  tracer?: MessageTracer;
}

export class AdapterNativeHandler implements CommandHandler {
  readonly name = "adapter-native";
  private readonly tracer: MessageTracer;

  constructor(private deps: AdapterNativeHandlerDeps) {
    this.tracer = deps.tracer ?? noopTracer;
  }

  handles(ctx: CommandHandlerContext): boolean {
    return ctx.session.adapterSlashExecutor?.handles(ctx.command) ?? false;
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, slashRequestId, traceId, startedAtMs, session } = ctx;
    if (!session.adapterSlashExecutor) return;
    this.tracer.recv(
      "bridge",
      "slash_command",
      { command },
      {
        sessionId: session.id,
        traceId,
        requestId: slashRequestId,
        command,
        phase: "dispatch_adapter_native",
      },
    );
    session.adapterSlashExecutor
      .execute(command)
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
        emitSlashSummary(this.tracer, {
          sessionId: session.id,
          traceId,
          requestId: slashRequestId,
          command,
          startedAtMs,
          outcome: "success",
          matchedPath: "result_field",
          reasons: [],
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
        emitSlashSummary(this.tracer, {
          sessionId: session.id,
          traceId,
          requestId: slashRequestId,
          command,
          startedAtMs,
          outcome: "backend_error",
          matchedPath: "none",
          reasons: [error],
        });
      });
  }
}

// ─── PassthroughHandler ───────────────────────────────────────────────────────

type SendUserMessage = (
  sessionId: string,
  content: string,
  trace?: {
    traceId: string;
    requestId: string;
    command: string;
  },
) => void;

export interface PassthroughHandlerDeps {
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
  sendUserMessage: SendUserMessage;
  registerPendingPassthrough: (
    session: Session,
    entry: Session["pendingPassthroughs"][number],
  ) => void;
  tracer?: MessageTracer;
}

export class PassthroughHandler implements CommandHandler {
  readonly name = "passthrough";
  private readonly tracer: MessageTracer;

  constructor(private deps: PassthroughHandlerDeps) {
    this.tracer = deps.tracer ?? noopTracer;
  }

  handles(ctx: CommandHandlerContext): boolean {
    return ctx.session.adapterSupportsSlashPassthrough;
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, slashRequestId, traceId, startedAtMs, session } = ctx;
    const normalized = commandName(command);
    const pending = {
      command: normalized,
      requestId,
      slashRequestId,
      traceId,
      startedAtMs,
    };
    this.deps.registerPendingPassthrough(session, pending);
    this.tracer.send(
      "bridge",
      "slash_command",
      { command },
      {
        sessionId: session.id,
        traceId,
        requestId: slashRequestId,
        command,
        phase: "dispatch_passthrough",
      },
    );
    this.deps.sendUserMessage(session.id, command, {
      traceId,
      requestId: slashRequestId,
      command: normalized,
    });
  }
}

// ─── UnsupportedHandler ───────────────────────────────────────────────────────

export interface UnsupportedHandlerDeps {
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
  tracer?: MessageTracer;
}

export class UnsupportedHandler implements CommandHandler {
  readonly name = "unsupported";
  private readonly tracer: MessageTracer;

  constructor(private deps: UnsupportedHandlerDeps) {
    this.tracer = deps.tracer ?? noopTracer;
  }

  handles(_ctx: CommandHandlerContext): boolean {
    return true; // terminal handler — always catches
  }

  execute(ctx: CommandHandlerContext): void {
    const { command, requestId, slashRequestId, traceId, startedAtMs, session } = ctx;
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
    emitSlashSummary(this.tracer, {
      sessionId: session.id,
      traceId,
      requestId: slashRequestId,
      command,
      startedAtMs,
      outcome: "unmapped_type",
      matchedPath: "none",
      reasons: [error],
    });
  }
}

function emitSlashSummary(
  tracer: MessageTracer,
  opts: {
    sessionId: string;
    traceId: string;
    requestId: string;
    command: string;
    startedAtMs: number;
    outcome: TraceOutcome;
    matchedPath: "assistant_text" | "result_field" | "stream_buffer" | "none";
    reasons: string[];
  },
): void {
  tracer.send(
    "bridge",
    "slash_decision_summary",
    {
      matched_path: opts.matchedPath,
      drop_or_consume_reasons: opts.reasons,
      timings: {
        total_ms: Math.max(0, Date.now() - opts.startedAtMs),
      },
    },
    {
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      requestId: opts.requestId,
      command: opts.command,
      phase: "summary",
      outcome: opts.outcome,
    },
  );
}
