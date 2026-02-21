import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionCoordinator } from "./helpers/test-utils.js";
import {
  cleanupSessionCoordinator,
  closeWebSockets,
  connectTestConsumer,
  connectTestConsumerWithQuery,
  createTestSession,
  mockSlashCommand,
  sendAndWait,
  setupTestSessionCoordinator,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Consumer Edge Cases", () => {
  let tm: TestSessionCoordinator | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionCoordinator(tm);
      tm = undefined;
    }
  });

  it("ignores malformed JSON and keeps the consumer connection alive", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    consumer.send("{not-json");

    // If connection remains usable, slash command should still work
    const result = await sendAndWait(
      consumer,
      consumer,
      mockSlashCommand("/help"),
      "slash_command_result",
    );
    expect((result as { command: string }).command).toBe("/help");

    await closeWebSockets(consumer);
  });

  it("ignores invalid message shape and keeps the consumer connection alive", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    // Unknown type should be schema-rejected and ignored
    consumer.send(JSON.stringify({ type: "definitely_invalid_type", foo: "bar" }));

    const result = await sendAndWait(
      consumer,
      consumer,
      mockSlashCommand("/help", "req-edge-1"),
      "slash_command_result",
    );
    expect((result as { request_id: string }).request_id).toBe("req-edge-1");

    await closeWebSockets(consumer);
  });

  it("closes connection with 1009 for oversized messages", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);

    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    const closeCode = new Promise<number>((resolve) => {
      consumer.on("close", (code) => resolve(code));
    });

    const oversized = JSON.stringify({
      type: "user_message",
      content: "x".repeat(300_000), // exceeds MAX_CONSUMER_MESSAGE_SIZE (256KB)
    });
    consumer.send(oversized);

    expect(await closeCode).toBe(1009);
  });

  it("returns error when sending participant-only message from observer role", async () => {
    tm = await setupTestSessionCoordinator({
      authenticator: {
        async authenticate(context) {
          const query = context.transport.query as Record<string, string> | undefined;
          const role = query?.role === "observer" ? "observer" : "participant";
          return {
            userId: role === "observer" ? "obs-1" : "part-1",
            displayName: role === "observer" ? "Observer 1" : "Participant 1",
            role,
          };
        },
      },
    });
    const { sessionId, port } = createTestSession(tm);

    const observer = await connectTestConsumerWithQuery(port, sessionId, { role: "observer" });
    await waitForMessageType(observer, "session_init");

    observer.send(JSON.stringify({ type: "user_message", content: "observer write attempt" }));
    const err = (await waitForMessageType(observer, "error")) as { type: "error"; message: string };

    expect(err.type).toBe("error");
    expect(err.message).toContain("Observers cannot send user_message messages");
    await closeWebSockets(observer);
  });
});
