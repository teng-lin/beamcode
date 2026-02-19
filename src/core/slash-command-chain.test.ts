import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../testing/cli-message-factories.js";
import {
  type CommandHandler,
  type CommandHandlerContext,
  SlashCommandChain,
} from "./slash-command-chain.js";

function makeHandler(handles: boolean, name = "test"): CommandHandler {
  return {
    handles: vi.fn().mockReturnValue(handles),
    execute: vi.fn(),
    name,
  };
}

function makeContext(): CommandHandlerContext {
  return {
    command: "/compact",
    requestId: "req-1",
    session: createMockSession(),
  };
}

describe("SlashCommandChain", () => {
  it("calls execute on the first handler that handles the command", () => {
    const h1 = makeHandler(false, "h1");
    const h2 = makeHandler(true, "h2");
    const h3 = makeHandler(true, "h3");
    const chain = new SlashCommandChain([h1, h2, h3]);
    const ctx = makeContext();

    chain.dispatch(ctx);

    expect(h1.execute).not.toHaveBeenCalled();
    expect(h2.execute).toHaveBeenCalledWith(ctx);
    expect(h3.execute).not.toHaveBeenCalled();
  });

  it("skips handlers that return false from handles()", () => {
    const h1 = makeHandler(false);
    const h2 = makeHandler(false);
    const chain = new SlashCommandChain([h1, h2]);
    const ctx = makeContext();

    // No crash — falls off end (UnsupportedHandler prevents this in practice)
    expect(() => chain.dispatch(ctx)).not.toThrow();
  });

  it("passes handles() the command and session", () => {
    const handler = makeHandler(true);
    const chain = new SlashCommandChain([handler]);
    const ctx = makeContext();

    chain.dispatch(ctx);

    expect(handler.handles).toHaveBeenCalledWith(ctx);
  });
});
