import { describe, expect, it, vi } from "vitest";
import {
  createMockSession,
  createTestSocket,
  findMessage,
  flushPromises,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";
import { SlashCommandHandler, type SlashCommandHandlerDeps } from "./slash-command-handler.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function setup(overrides?: { executor?: SlashCommandExecutor }) {
  const executor = overrides?.executor ?? new SlashCommandExecutor();
  const broadcaster = new ConsumerBroadcaster(noopLogger);
  const sendUserMessage = vi.fn();
  const emitEvent = vi.fn();

  const deps: SlashCommandHandlerDeps = {
    executor,
    broadcaster,
    sendUserMessage,
    emitEvent,
  };
  const handler = new SlashCommandHandler(deps);

  const ws = createTestSocket();
  const session = createMockSession();
  session.consumerSockets.set(ws, {
    userId: "user-1",
    displayName: "Alice",
    role: "participant",
    sessionId: "sess-1",
  });

  return { handler, executor, broadcaster, sendUserMessage, emitEvent, session, ws };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SlashCommandHandler", () => {
  describe("handleSlashCommand — forwarded commands", () => {
    it("forwards non-local commands to CLI via sendUserMessage", () => {
      const { handler, sendUserMessage, session } = setup();

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/compact",
      });

      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "/compact");
    });

    it("sets pendingPassthrough with command name and request_id", () => {
      const { handler, session } = setup();

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/model sonnet",
        request_id: "req-1",
      });

      expect(session.pendingPassthrough).toEqual({
        command: "/model",
        requestId: "req-1",
      });
    });

    it("sets pendingPassthrough without request_id when not provided", () => {
      const { handler, session } = setup();

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/compact",
      });

      expect(session.pendingPassthrough).toEqual({
        command: "/compact",
        requestId: undefined,
      });
    });
  });

  describe("handleSlashCommand — local commands (success)", () => {
    it("broadcasts slash_command_result for /help", async () => {
      const { handler, session, ws } = setup();

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/help",
        request_id: "req-help",
      });

      await flushPromises();

      const result = findMessage(ws, "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/help");
      expect(result.request_id).toBe("req-help");
      expect(result.content).toContain("Available commands:");
      expect(result.source).toBe("emulated");
    });

    it("emits slash_command:executed event on success", async () => {
      const { handler, emitEvent, session } = setup();

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/help",
      });

      await flushPromises();

      expect(emitEvent).toHaveBeenCalledWith(
        "slash_command:executed",
        expect.objectContaining({
          sessionId: "sess-1",
          command: "/help",
          source: "emulated",
        }),
      );
    });
  });

  describe("handleSlashCommand — local command failure (.catch path)", () => {
    it("broadcasts slash_command_error when executeLocal rejects", async () => {
      const executor = new SlashCommandExecutor();
      vi.spyOn(executor, "shouldForwardToCLI").mockReturnValue(false);
      vi.spyOn(executor, "executeLocal").mockRejectedValue(new Error("boom"));

      const { handler, session, ws } = setup({ executor });

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/broken",
        request_id: "req-fail",
      });

      await flushPromises();

      const error = findMessage(ws, "slash_command_error");
      expect(error).toBeDefined();
      expect(error.command).toBe("/broken");
      expect(error.request_id).toBe("req-fail");
      expect(error.error).toBe("boom");
    });

    it("emits slash_command:failed event when executeLocal rejects", async () => {
      const executor = new SlashCommandExecutor();
      vi.spyOn(executor, "shouldForwardToCLI").mockReturnValue(false);
      vi.spyOn(executor, "executeLocal").mockRejectedValue(new Error("kaboom"));

      const { handler, emitEvent, session } = setup({ executor });

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/broken",
      });

      await flushPromises();

      expect(emitEvent).toHaveBeenCalledWith("slash_command:failed", {
        sessionId: "sess-1",
        command: "/broken",
        error: "kaboom",
      });
    });

    it("handles non-Error rejection by converting to string", async () => {
      const executor = new SlashCommandExecutor();
      vi.spyOn(executor, "shouldForwardToCLI").mockReturnValue(false);
      vi.spyOn(executor, "executeLocal").mockRejectedValue("string error");

      const { handler, session, ws } = setup({ executor });

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/broken",
      });

      await flushPromises();

      const error = findMessage(ws, "slash_command_error");
      expect(error).toBeDefined();
      expect(error.error).toBe("string error");
    });
  });

  describe("handleSlashCommand — concurrent passthrough", () => {
    it("queues two forwarded commands without clobbering", () => {
      const { handler, session } = setup();

      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/compact",
        request_id: "req-1",
      });
      handler.handleSlashCommand(session, {
        type: "slash_command",
        command: "/model",
        request_id: "req-2",
      });

      expect(session.pendingPassthroughs).toHaveLength(2);
      expect(session.pendingPassthroughs[0]).toEqual({ command: "/compact", requestId: "req-1" });
      expect(session.pendingPassthroughs[1]).toEqual({ command: "/model", requestId: "req-2" });
    });
  });

  describe("executeSlashCommand (programmatic API)", () => {
    it("returns content and source for local commands", async () => {
      const { handler, session } = setup();

      const result = await handler.executeSlashCommand(session, "/help");

      expect(result).not.toBeNull();
      expect(result!.content).toContain("Available commands:");
      expect(result!.source).toBe("emulated");
    });

    it("returns null for forwarded commands", async () => {
      const { handler, sendUserMessage, session } = setup();

      const result = await handler.executeSlashCommand(session, "/compact");

      expect(result).toBeNull();
      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "/compact");
    });

    it("sets pendingPassthrough for forwarded commands", async () => {
      const { handler, session } = setup();

      await handler.executeSlashCommand(session, "/model sonnet");

      expect(session.pendingPassthrough).toEqual({
        command: "/model",
        requestId: undefined,
      });
    });

    it("propagates errors from executeLocal", async () => {
      const executor = new SlashCommandExecutor();
      vi.spyOn(executor, "shouldForwardToCLI").mockReturnValue(false);
      vi.spyOn(executor, "executeLocal").mockRejectedValue(new Error("exec failed"));

      const { handler, session } = setup({ executor });

      await expect(handler.executeSlashCommand(session, "/broken")).rejects.toThrow("exec failed");
    });
  });
});
