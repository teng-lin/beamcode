import { describe, expect, it, vi } from "vitest";
import {
  createMockSession,
  createTestSocket,
  findMessage,
  flushPromises,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import {
  AdapterNativeHandler,
  type CommandHandler,
  type CommandHandlerContext,
  LocalHandler,
  PassthroughHandler,
  SlashCommandChain,
  UnsupportedHandler,
} from "./slash-command-chain.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";

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

// ─── LocalHandler ─────────────────────────────────────────────────────────────

function makeLocalSetup() {
  const executor = new SlashCommandExecutor();
  const broadcaster = new ConsumerBroadcaster(noopLogger);
  const emitEvent = vi.fn();
  const handler = new LocalHandler({ executor, broadcaster, emitEvent });
  const ws = createTestSocket();
  const session = createMockSession();
  session.consumerSockets.set(ws, {
    userId: "u1",
    displayName: "Alice",
    role: "participant",
  });
  return { handler, ws, session, emitEvent };
}

describe("LocalHandler", () => {
  it("handles /help", () => {
    const { handler, session } = makeLocalSetup();
    expect(handler.handles({ command: "/help", requestId: undefined, session })).toBe(true);
  });

  it("does not handle /compact", () => {
    const { handler, session } = makeLocalSetup();
    expect(handler.handles({ command: "/compact", requestId: undefined, session })).toBe(false);
  });

  it("executes /help and broadcasts slash_command_result", async () => {
    const { handler, ws, session } = makeLocalSetup();
    handler.execute({ command: "/help", requestId: "r1", session });
    await flushPromises();
    const msg = findMessage(ws, "slash_command_result");
    expect(msg).toBeDefined();
    expect(msg.command).toBe("/help");
    expect(msg.request_id).toBe("r1");
    expect(msg.source).toBe("emulated");
    expect(msg.content).toContain("Available commands:");
  });

  it("broadcasts slash_command_error when executor rejects", async () => {
    const executor = new SlashCommandExecutor();
    const broadcaster = new ConsumerBroadcaster(noopLogger);
    vi.spyOn(executor, "executeLocal").mockRejectedValue(new Error("boom"));
    const handler = new LocalHandler({ executor, broadcaster, emitEvent: vi.fn() });
    const ws = createTestSocket();
    const session = createMockSession();
    session.consumerSockets.set(ws, {
      userId: "u1",
      displayName: "Alice",
      role: "participant",
    });
    handler.execute({ command: "/help", requestId: "r1", session });
    await flushPromises();
    const msg = findMessage(ws, "slash_command_error");
    expect(msg.error).toBe("boom");
  });

  it("emits slash_command:executed on success", async () => {
    const { handler, session, emitEvent } = makeLocalSetup();
    handler.execute({ command: "/help", requestId: undefined, session });
    await flushPromises();
    expect(emitEvent).toHaveBeenCalledWith(
      "slash_command:executed",
      expect.objectContaining({ command: "/help", source: "emulated" }),
    );
  });
});

// ─── AdapterNativeHandler ─────────────────────────────────────────────────────

describe("AdapterNativeHandler", () => {
  it("handles command when adapterSlashExecutor handles it", () => {
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockResolvedValue({ content: "ok", source: "emulated", durationMs: 10 }),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const broadcaster = new ConsumerBroadcaster(noopLogger);
    const handler = new AdapterNativeHandler({ broadcaster, emitEvent: vi.fn() });
    expect(handler.handles({ command: "/compact", requestId: undefined, session })).toBe(true);
  });

  it("does not handle when adapterSlashExecutor is null", () => {
    const session = createMockSession();
    session.adapterSlashExecutor = null;
    const broadcaster = new ConsumerBroadcaster(noopLogger);
    const handler = new AdapterNativeHandler({ broadcaster, emitEvent: vi.fn() });
    expect(handler.handles({ command: "/compact", requestId: undefined, session })).toBe(false);
  });

  it("broadcasts result from adapter executor", async () => {
    const session = createMockSession();
    const ws = createTestSocket();
    session.consumerSockets.set(ws, {
      userId: "u1",
      displayName: "Alice",
      role: "participant",
    });
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi
        .fn()
        .mockResolvedValue({ content: "compact done", source: "emulated", durationMs: 5 }),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const broadcaster = new ConsumerBroadcaster(noopLogger);
    const handler = new AdapterNativeHandler({ broadcaster, emitEvent: vi.fn() });
    handler.execute({ command: "/compact", requestId: "r1", session });
    await flushPromises();
    const msg = findMessage(ws, "slash_command_result");
    expect(msg.content).toBe("compact done");
  });
});

// ─── PassthroughHandler ───────────────────────────────────────────────────────

describe("PassthroughHandler", () => {
  it("handles any command when adapter supports passthrough", () => {
    const session = createMockSession();
    session.adapterSupportsSlashPassthrough = true;
    const handler = new PassthroughHandler({
      broadcaster: new ConsumerBroadcaster(noopLogger),
      emitEvent: vi.fn(),
      sendUserMessage: vi.fn(),
    });
    expect(handler.handles({ command: "/any-cmd", requestId: undefined, session })).toBe(true);
  });

  it("does not handle when adapter does not support passthrough", () => {
    const session = createMockSession();
    session.adapterSupportsSlashPassthrough = false;
    const handler = new PassthroughHandler({
      broadcaster: new ConsumerBroadcaster(noopLogger),
      emitEvent: vi.fn(),
      sendUserMessage: vi.fn(),
    });
    expect(handler.handles({ command: "/compact", requestId: undefined, session })).toBe(false);
  });

  it("pushes to pendingPassthroughs queue and calls sendUserMessage", () => {
    const sendUserMessage = vi.fn();
    const session = createMockSession();
    session.adapterSupportsSlashPassthrough = true;
    const handler = new PassthroughHandler({
      broadcaster: new ConsumerBroadcaster(noopLogger),
      emitEvent: vi.fn(),
      sendUserMessage,
    });
    handler.execute({ command: "/compact arg", requestId: "r1", session });
    expect(session.pendingPassthroughs).toEqual([{ command: "/compact", requestId: "r1" }]);
    expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "/compact arg");
  });
});

// ─── UnsupportedHandler ───────────────────────────────────────────────────────

describe("UnsupportedHandler", () => {
  it("always handles any command", () => {
    const session = createMockSession();
    const broadcaster = new ConsumerBroadcaster(noopLogger);
    const handler = new UnsupportedHandler({ broadcaster, emitEvent: vi.fn() });
    expect(handler.handles({ command: "/anything", requestId: undefined, session })).toBe(true);
  });

  it("broadcasts slash_command_error", async () => {
    const broadcaster = new ConsumerBroadcaster(noopLogger);
    const handler = new UnsupportedHandler({ broadcaster, emitEvent: vi.fn() });
    const ws = createTestSocket();
    const session = createMockSession();
    session.consumerSockets.set(ws, {
      userId: "u1",
      displayName: "Alice",
      role: "participant",
    });
    handler.execute({ command: "/unknown", requestId: "r1", session });
    const msg = findMessage(ws, "slash_command_error");
    expect(msg.error).toContain("/unknown");
    expect(msg.error).toContain("not supported");
  });
});
