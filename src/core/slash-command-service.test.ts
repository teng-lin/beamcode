import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../testing/cli-message-factories.js";
import { noopTracer } from "./message-tracer.js";
import { SlashCommandService } from "./slash-command-service.js";

describe("SlashCommandService", () => {
  it("handles inbound slash commands with generated ids and dispatches chain", () => {
    const session = createMockSession({ id: "s1" });
    const tracer = { ...noopTracer, recv: vi.fn() };
    const commandChain = { dispatch: vi.fn() };
    const localHandler = {
      handles: vi.fn(() => false),
      executeLocal: vi.fn(),
    };
    const service = new SlashCommandService({
      tracer: tracer as any,
      now: () => 1700000000000,
      generateTraceId: () => "t_test",
      generateSlashRequestId: () => "sr_test",
      commandChain,
      localHandler,
    });

    service.handleInbound(session, { type: "slash_command", command: "/help" });

    expect(tracer.recv).toHaveBeenCalledWith(
      "bridge",
      "slash_command",
      expect.objectContaining({ command: "/help" }),
      expect.objectContaining({
        sessionId: "s1",
        traceId: "t_test",
        requestId: "sr_test",
        command: "/help",
      }),
    );
    expect(commandChain.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/help",
        requestId: undefined,
        slashRequestId: "sr_test",
        traceId: "t_test",
        startedAtMs: 1700000000000,
        session,
      }),
    );
  });

  it("preserves inbound request id when present", () => {
    const session = createMockSession({ id: "s1" });
    const commandChain = { dispatch: vi.fn() };
    const service = new SlashCommandService({
      tracer: { ...noopTracer, recv: vi.fn() } as any,
      now: () => 1700000000000,
      generateTraceId: () => "t_test",
      generateSlashRequestId: () => "sr_test",
      commandChain,
      localHandler: { handles: vi.fn(() => false), executeLocal: vi.fn() },
    });

    service.handleInbound(session, {
      type: "slash_command",
      command: "/model",
      request_id: "req-1",
    });

    expect(commandChain.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        slashRequestId: "req-1",
      }),
    );
  });

  it("returns emulated result for local programmatic command", async () => {
    const session = createMockSession({ id: "s1" });
    const commandChain = { dispatch: vi.fn() };
    const localHandler = {
      handles: vi.fn(() => true),
      executeLocal: vi.fn(async () => ({ content: "help", source: "emulated" as const })),
    };
    const service = new SlashCommandService({
      tracer: noopTracer,
      now: () => 1700000000000,
      generateTraceId: () => "t_test",
      generateSlashRequestId: () => "sr_test",
      commandChain,
      localHandler,
    });

    const result = await service.executeProgrammatic(session, "/help");

    expect(result).toEqual({ content: "help", source: "emulated" });
    expect(localHandler.executeLocal).toHaveBeenCalled();
    expect(commandChain.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches non-local programmatic command and returns null", async () => {
    const session = createMockSession({ id: "s1" });
    const commandChain = { dispatch: vi.fn() };
    const service = new SlashCommandService({
      tracer: noopTracer,
      now: () => 1700000000000,
      generateTraceId: () => "t_test",
      generateSlashRequestId: () => "sr_test",
      commandChain,
      localHandler: { handles: vi.fn(() => false), executeLocal: vi.fn() },
    });

    const result = await service.executeProgrammatic(session, "/status");

    expect(result).toBeNull();
    expect(commandChain.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/status",
        slashRequestId: "sr_test",
      }),
    );
  });
});
