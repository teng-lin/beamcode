import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isInvertedConnectionAdapter } from "../../core/interfaces/inverted-connection-adapter.js";
import { tick } from "../../testing/adapter-test-helpers.js";
import { SdkUrlAdapter } from "./sdk-url-adapter.js";
import { SdkUrlSession } from "./sdk-url-session.js";

// Minimal mock WebSocket
class MockWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

describe("SdkUrlAdapter", () => {
  const adapter = new SdkUrlAdapter();

  describe("name", () => {
    it("is 'sdk-url'", () => {
      expect(adapter.name).toBe("sdk-url");
    });
  });

  describe("capabilities", () => {
    it("exposes correct capability values", () => {
      expect(adapter.capabilities).toEqual({
        streaming: true,
        permissions: true,
        slashCommands: true,
        availability: "local",
        teams: true,
      });
    });
  });

  describe("isInvertedConnectionAdapter", () => {
    it("returns true for SdkUrlAdapter", () => {
      expect(isInvertedConnectionAdapter(adapter)).toBe(true);
    });
  });

  describe("connect", () => {
    it("returns an SdkUrlSession with deferred socket", async () => {
      const session = await adapter.connect({ sessionId: "sess-1" });
      expect(session).toBeInstanceOf(SdkUrlSession);
      expect(session.sessionId).toBe("sess-1");
      await session.close();
    });
  });

  describe("deliverSocket", () => {
    it("resolves the session's socket promise", async () => {
      const adapter = new SdkUrlAdapter();
      const session = await adapter.connect({ sessionId: "sess-2" });

      const ws = new MockWebSocket() as any;
      const delivered = adapter.deliverSocket("sess-2", ws);
      expect(delivered).toBe(true);

      // After delivery, send should go through to the socket
      await tick();
      session.sendRaw('{"test":true}');
      expect(ws.sent).toContain('{"test":true}\n');

      await session.close();
    });

    it("returns false for unknown session", () => {
      const adapter = new SdkUrlAdapter();
      const ws = new MockWebSocket() as any;
      expect(adapter.deliverSocket("unknown", ws)).toBe(false);
    });
  });

  describe("cancelPending", () => {
    it("cancels a pending socket registration", async () => {
      const adapter = new SdkUrlAdapter();
      const session = await adapter.connect({ sessionId: "sess-3" });

      adapter.cancelPending("sess-3");

      // Session should be terminated (socket promise rejected)
      await tick();
      // Verify session is done by checking that close doesn't throw
      await session.close();
    });
  });

  describe("connect + deliverSocket integration", () => {
    it("produces a working send/receive channel", async () => {
      const adapter = new SdkUrlAdapter();
      const session = await adapter.connect({ sessionId: "sess-4" });

      const ws = new MockWebSocket() as any;
      adapter.deliverSocket("sess-4", ws);
      await tick();

      // Send a message through the session
      session.sendRaw('{"type":"user","message":{"role":"user","content":"hello"}}');
      expect(ws.sent).toHaveLength(1);

      // Simulate incoming message from CLI
      const iter = session.messages[Symbol.asyncIterator]();
      const initMsg = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-4",
        model: "claude-3",
        cwd: "/tmp",
        tools: [],
        mcp_servers: [],
      });
      ws.emit("message", initMsg);

      const result = await iter.next();
      expect(result.done).toBe(false);
      expect(result.value.type).toBe("session_init");

      await session.close();
    });
  });
});
