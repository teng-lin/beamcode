/**
 * BackendAdapter compliance test suite — a reusable harness that any
 * BackendAdapter implementation can run to verify contract conformance.
 *
 * Usage:
 *   import { runBackendAdapterComplianceTests } from "./backend-adapter-compliance.js";
 *   runBackendAdapterComplianceTests("MyAdapter", () => new MyAdapter());
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUnifiedMessage, isUnifiedMessage } from "../types/unified-message.js";
import type { BackendAdapter } from "./backend-adapter.js";

/**
 * Run the full BackendAdapter compliance suite against the given factory.
 *
 * @param name    - Human-readable adapter name (used in describe blocks).
 * @param createAdapter - Factory that returns a fresh adapter per test group.
 * @param options - Optional overrides (e.g. per-test timeout).
 */
export function runBackendAdapterComplianceTests(
  name: string,
  createAdapter: () => BackendAdapter,
  options?: { timeout?: number },
): void {
  const timeout = options?.timeout ?? 5_000;

  describe(`BackendAdapter compliance: ${name}`, () => {
    let adapter: BackendAdapter;

    beforeEach(() => {
      adapter = createAdapter();
    });

    // -----------------------------------------------------------------
    // 1. Adapter properties
    // -----------------------------------------------------------------

    describe("adapter properties", () => {
      it("has a non-empty name", () => {
        expect(typeof adapter.name).toBe("string");
        expect(adapter.name.length).toBeGreaterThan(0);
      });

      it("has well-formed capabilities", () => {
        const caps = adapter.capabilities;
        expect(typeof caps.streaming).toBe("boolean");
        expect(typeof caps.permissions).toBe("boolean");
        expect(typeof caps.slashCommands).toBe("boolean");
        expect(["local", "remote", "both"]).toContain(caps.availability);
      });
    });

    // -----------------------------------------------------------------
    // 2. Connect lifecycle
    // -----------------------------------------------------------------

    describe("connect lifecycle", () => {
      it(
        "returns a session with the requested sessionId",
        async () => {
          const session = await adapter.connect({
            sessionId: "compliance-connect",
          });
          expect(session.sessionId).toBe("compliance-connect");
          await session.close();
        },
        timeout,
      );
    });

    // -----------------------------------------------------------------
    // 3. Send / receive
    // -----------------------------------------------------------------

    describe("send and receive", () => {
      it(
        "receives a valid UnifiedMessage after sending",
        async () => {
          const session = await adapter.connect({
            sessionId: "compliance-send-recv",
          });

          const msg = createUnifiedMessage({
            type: "user_message",
            role: "user",
            content: [{ type: "text", text: "compliance test" }],
          });

          session.send(msg);

          const iter = session.messages[Symbol.asyncIterator]();
          const { value, done } = await iter.next();

          expect(done).toBe(false);
          expect(isUnifiedMessage(value)).toBe(true);

          await session.close();
        },
        timeout,
      );
    });

    // -----------------------------------------------------------------
    // 4. Close behaviour
    // -----------------------------------------------------------------

    describe("close behaviour", () => {
      it(
        "terminates the message stream",
        async () => {
          const session = await adapter.connect({
            sessionId: "compliance-close-stream",
          });
          await session.close();

          const iter = session.messages[Symbol.asyncIterator]();
          const { done } = await iter.next();
          expect(done).toBe(true);
        },
        timeout,
      );

      it(
        "send() throws after close()",
        async () => {
          const session = await adapter.connect({
            sessionId: "compliance-close-send",
          });
          await session.close();

          const msg = createUnifiedMessage({
            type: "user_message",
            role: "user",
          });
          expect(() => session.send(msg)).toThrow();
        },
        timeout,
      );
    });

    // -----------------------------------------------------------------
    // 5. Concurrent sessions
    // -----------------------------------------------------------------

    describe("concurrent sessions", () => {
      it(
        "two sessions operate independently",
        async () => {
          const s1 = await adapter.connect({
            sessionId: "compliance-conc-1",
          });
          const s2 = await adapter.connect({
            sessionId: "compliance-conc-2",
          });

          expect(s1.sessionId).toBe("compliance-conc-1");
          expect(s2.sessionId).toBe("compliance-conc-2");

          const msg1 = createUnifiedMessage({
            type: "user_message",
            role: "user",
          });
          const msg2 = createUnifiedMessage({
            type: "user_message",
            role: "user",
          });

          s1.send(msg1);
          s2.send(msg2);

          const iter1 = s1.messages[Symbol.asyncIterator]();
          const iter2 = s2.messages[Symbol.asyncIterator]();

          const [r1, r2] = await Promise.all([iter1.next(), iter2.next()]);

          expect(r1.done).toBe(false);
          expect(r2.done).toBe(false);
          expect(isUnifiedMessage(r1.value)).toBe(true);
          expect(isUnifiedMessage(r2.value)).toBe(true);

          await s1.close();
          await s2.close();
        },
        timeout,
      );

      it(
        "closing one session does not affect another",
        async () => {
          const s1 = await adapter.connect({
            sessionId: "compliance-iso-1",
          });
          const s2 = await adapter.connect({
            sessionId: "compliance-iso-2",
          });

          await s1.close();

          // s2 must still function
          const msg = createUnifiedMessage({
            type: "user_message",
            role: "user",
          });
          s2.send(msg);

          const iter = s2.messages[Symbol.asyncIterator]();
          const { value } = await iter.next();
          expect(isUnifiedMessage(value)).toBe(true);

          await s2.close();
        },
        timeout,
      );
    });

    // -----------------------------------------------------------------
    // 6. Resume
    // -----------------------------------------------------------------

    describe("resume support", () => {
      it(
        "accepts resume option without error",
        async () => {
          const session = await adapter.connect({
            sessionId: "compliance-resume",
            resume: true,
          });
          expect(session.sessionId).toBe("compliance-resume");
          await session.close();
        },
        timeout,
      );
    });

    // -----------------------------------------------------------------
    // 7. Error handling
    // -----------------------------------------------------------------

    describe("error handling", () => {
      it("connect() returns a promise (awaitable)", () => {
        const result = adapter.connect({ sessionId: "compliance-err" });
        expect(result).toBeInstanceOf(Promise);
        // Clean up — ignore rejection from adapters that may fail here
        result.then((s) => s.close()).catch(() => {});
      });
    });
  });
}
