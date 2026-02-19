import type { Session } from "./session-store.js";

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
