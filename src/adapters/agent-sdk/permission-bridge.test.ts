import { describe, expect, it } from "vitest";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { PermissionBridge } from "./permission-bridge.js";

function createBridge() {
  const emitted: UnifiedMessage[] = [];
  const emitter = (msg: UnifiedMessage) => emitted.push(msg);
  const bridge = new PermissionBridge(emitter);
  return { bridge, emitted };
}

describe("PermissionBridge", () => {
  describe("handleToolRequest", () => {
    it("emits a permission_request UnifiedMessage", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest("Bash", { command: "ls" });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("permission_request");
      expect(emitted[0].role).toBe("system");

      // Resolve to avoid hanging
      const requestId = emitted[0].metadata.requestId as string;
      bridge.respondToPermission(requestId, "allow");
      await promise;
    });

    it("emits correct metadata (requestId, toolName, input, description)", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest("Read", { path: "/tmp/foo" });

      const meta = emitted[0].metadata;
      expect(meta.requestId).toEqual(expect.any(String));
      expect(meta.toolName).toBe("Read");
      expect(meta.input).toEqual({ path: "/tmp/foo" });
      expect(meta.description).toContain("Read:");

      bridge.respondToPermission(meta.requestId as string, "allow");
      await promise;
    });

    it("truncates long input in description", async () => {
      const { bridge, emitted } = createBridge();

      const longInput = { data: "x".repeat(200) };
      const promise = bridge.handleToolRequest("Write", longInput);

      const desc = emitted[0].metadata.description as string;
      expect(desc.length).toBeLessThanOrEqual(107); // "Write: " + 100 chars

      bridge.respondToPermission(emitted[0].metadata.requestId as string, "allow");
      await promise;
    });
  });

  describe("respondToPermission", () => {
    it("resolves the Promise with allow", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest("Bash", { command: "ls" });
      const requestId = emitted[0].metadata.requestId as string;

      const result = bridge.respondToPermission(requestId, "allow");

      expect(result).toBe(true);

      const decision = await promise;
      expect(decision.behavior).toBe("allow");
      expect(decision.updatedInput).toEqual({ command: "ls" });
      expect(decision.message).toBeUndefined();
    });

    it("resolves the Promise with deny", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest("Bash", { command: "rm -rf /" });
      const requestId = emitted[0].metadata.requestId as string;

      bridge.respondToPermission(requestId, "deny");

      const decision = await promise;
      expect(decision.behavior).toBe("deny");
      expect(decision.message).toBe("User denied permission");
    });

    it("passes updatedInput when provided", async () => {
      const { bridge, emitted } = createBridge();

      const promise = bridge.handleToolRequest("Edit", { file: "a.ts" });
      const requestId = emitted[0].metadata.requestId as string;

      bridge.respondToPermission(requestId, "allow", { file: "b.ts" });

      const decision = await promise;
      expect(decision.updatedInput).toEqual({ file: "b.ts" });
    });

    it("returns false for unknown requestId", () => {
      const { bridge } = createBridge();

      const result = bridge.respondToPermission("nonexistent-id", "allow");
      expect(result).toBe(false);
    });
  });

  describe("concurrent permissions", () => {
    it("tracks multiple pending permissions independently", async () => {
      const { bridge, emitted } = createBridge();

      const p1 = bridge.handleToolRequest("Bash", { command: "ls" });
      const p2 = bridge.handleToolRequest("Read", { path: "/tmp" });
      const p3 = bridge.handleToolRequest("Write", { file: "a.ts" });

      expect(bridge.pendingCount).toBe(3);
      expect(emitted).toHaveLength(3);

      const id1 = emitted[0].metadata.requestId as string;
      const id2 = emitted[1].metadata.requestId as string;
      const id3 = emitted[2].metadata.requestId as string;

      // Resolve in different order
      bridge.respondToPermission(id2, "deny");
      bridge.respondToPermission(id3, "allow");
      bridge.respondToPermission(id1, "allow");

      const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
      expect(d1.behavior).toBe("allow");
      expect(d2.behavior).toBe("deny");
      expect(d3.behavior).toBe("allow");
    });
  });

  describe("rejectAll", () => {
    it("resolves all pending with deny", async () => {
      const { bridge } = createBridge();

      const p1 = bridge.handleToolRequest("Bash", { command: "ls" });
      const p2 = bridge.handleToolRequest("Read", { path: "/tmp" });

      bridge.rejectAll();

      const [d1, d2] = await Promise.all([p1, p2]);
      expect(d1.behavior).toBe("deny");
      expect(d1.message).toBe("Session closed");
      expect(d2.behavior).toBe("deny");
      expect(d2.message).toBe("Session closed");
    });

    it("clears pending map", () => {
      const { bridge } = createBridge();

      bridge.handleToolRequest("Bash", { command: "ls" });
      bridge.handleToolRequest("Read", { path: "/tmp" });

      expect(bridge.pendingCount).toBe(2);
      bridge.rejectAll();
      expect(bridge.pendingCount).toBe(0);
    });
  });

  describe("pendingCount", () => {
    it("reflects current state", async () => {
      const { bridge, emitted } = createBridge();

      expect(bridge.pendingCount).toBe(0);

      const p1 = bridge.handleToolRequest("Bash", { command: "ls" });
      expect(bridge.pendingCount).toBe(1);

      bridge.handleToolRequest("Read", { path: "/tmp" });
      expect(bridge.pendingCount).toBe(2);

      bridge.respondToPermission(emitted[0].metadata.requestId as string, "allow");
      expect(bridge.pendingCount).toBe(1);

      await p1;
      bridge.rejectAll();
      expect(bridge.pendingCount).toBe(0);
    });
  });
});
