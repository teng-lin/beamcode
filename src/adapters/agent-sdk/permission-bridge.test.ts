import { describe, expect, it, vi } from "vitest";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { PermissionBridge } from "./permission-bridge.js";

describe("PermissionBridge", () => {
  function createBridge() {
    const emitted: UnifiedMessage[] = [];
    const bridge = new PermissionBridge((msg) => emitted.push(msg));
    return { bridge, emitted };
  }

  describe("handleToolRequest", () => {
    it("emits a permission_request UnifiedMessage", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest(
        "Bash",
        { command: "ls" },
        {
          toolUseId: "tool-1",
        },
      );

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("permission_request");
      expect(emitted[0].metadata.tool_name).toBe("Bash");
      expect(emitted[0].metadata.request_id).toBe("tool-1");
      expect(emitted[0].metadata.input).toEqual({ command: "ls" });

      // Resolve to prevent timeout
      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { request_id: "tool-1", approved: true },
        }),
      );

      const result = await promise;
      expect(result.behavior).toBe("allow");
    });

    it("includes optional fields in permission_request", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest(
        "Read",
        { path: "/etc/hosts" },
        {
          toolUseId: "tool-2",
          agentId: "agent-1",
          blockedPath: "/etc/hosts",
          decisionReason: "Reading system file",
          suggestions: [{ type: "addRules" }],
        },
      );

      expect(emitted[0].metadata.agent_id).toBe("agent-1");
      expect(emitted[0].metadata.blocked_path).toBe("/etc/hosts");
      expect(emitted[0].metadata.description).toBe("Reading system file");
      expect(emitted[0].metadata.permission_suggestions).toEqual([{ type: "addRules" }]);

      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { request_id: "tool-2", approved: true },
        }),
      );

      await promise;
    });
  });

  describe("resolve", () => {
    it("resolves with allow when approved", async () => {
      const { bridge } = createBridge();

      const promise = bridge.handleToolRequest(
        "Bash",
        { command: "ls" },
        {
          toolUseId: "tool-3",
        },
      );

      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { request_id: "tool-3", approved: true },
        }),
      );

      const result = await promise;
      expect(result.behavior).toBe("allow");
    });

    it("resolves with deny when not approved", async () => {
      const { bridge } = createBridge();

      const promise = bridge.handleToolRequest(
        "Bash",
        { command: "rm -rf /" },
        {
          toolUseId: "tool-4",
        },
      );

      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: {
            request_id: "tool-4",
            approved: false,
            message: "Too dangerous",
          },
        }),
      );

      const result = await promise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("Too dangerous");
    });

    it("passes through updatedInput on allow", async () => {
      const { bridge } = createBridge();

      const promise = bridge.handleToolRequest(
        "Bash",
        { command: "ls" },
        {
          toolUseId: "tool-5",
        },
      );

      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: {
            request_id: "tool-5",
            approved: true,
            updated_input: { command: "ls -la" },
          },
        }),
      );

      const result = await promise;
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toEqual({ command: "ls -la" });
    });

    it("ignores responses with no matching request_id", () => {
      const { bridge } = createBridge();

      // Should not throw
      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { request_id: "nonexistent", approved: true },
        }),
      );
    });

    it("ignores responses with no request_id", () => {
      const { bridge } = createBridge();

      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { approved: true },
        }),
      );
    });
  });

  describe("cancelAll", () => {
    it("denies all pending requests", async () => {
      const { bridge } = createBridge();

      const p1 = bridge.handleToolRequest("Bash", {}, { toolUseId: "t1" });
      const p2 = bridge.handleToolRequest("Read", {}, { toolUseId: "t2" });

      expect(bridge.pendingCount).toBe(2);
      bridge.cancelAll();
      expect(bridge.pendingCount).toBe(0);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.behavior).toBe("deny");
      expect(r1.message).toBe("Session closed");
      expect(r2.behavior).toBe("deny");
      expect(r2.message).toBe("Session closed");
    });
  });

  describe("timeout", () => {
    it("denies on timeout", async () => {
      vi.useFakeTimers();

      const { bridge } = createBridge();

      const promise = bridge.handleToolRequest("Bash", {}, { toolUseId: "t-timeout" });

      // Fast-forward past the 2-minute timeout
      vi.advanceTimersByTime(120_001);

      const result = await promise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("Permission request timed out");

      vi.useRealTimers();
    });
  });

  describe("pendingCount", () => {
    it("tracks pending requests", async () => {
      const { bridge } = createBridge();

      expect(bridge.pendingCount).toBe(0);

      const p1 = bridge.handleToolRequest("Bash", {}, { toolUseId: "pc-1" });
      expect(bridge.pendingCount).toBe(1);

      const p2 = bridge.handleToolRequest("Read", {}, { toolUseId: "pc-2" });
      expect(bridge.pendingCount).toBe(2);

      bridge.resolve(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { request_id: "pc-1", approved: true },
        }),
      );
      expect(bridge.pendingCount).toBe(1);

      bridge.cancelAll();
      expect(bridge.pendingCount).toBe(0);

      await Promise.all([p1, p2]);
    });
  });
});
