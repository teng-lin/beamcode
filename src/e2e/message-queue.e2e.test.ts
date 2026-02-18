import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionManager } from "./helpers/test-utils.js";
import {
  cleanupSessionManager,
  closeWebSockets,
  connectTestCLI,
  connectTestConsumer,
  createTestSession,
  mockResultMessage,
  setupTestSessionManager,
  waitForMessage,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Message Queue", () => {
  let tm: TestSessionManager | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionManager(tm);
      tm = undefined;
    }
  });

  it("queues a message while running and auto-sends on idle result", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    // Mark session as running.
    cli.send(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
        parent_tool_use_id: null,
      }),
    );
    await waitForMessageType(consumer, "status_change");

    consumer.send(JSON.stringify({ type: "queue_message", content: "queued hello" }));
    const queued = (await waitForMessageType(consumer, "message_queued")) as {
      type: "message_queued";
      content: string;
    };
    expect(queued.content).toBe("queued hello");

    // Result implies idle; queue handler should auto-send queued message.
    cli.send(JSON.stringify(mockResultMessage(sessionId, { text: "done" })));
    await waitForMessageType(consumer, "queued_message_sent");

    const cliUser = (await waitForMessage(
      cli,
      (m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "user",
    )) as { type: string; message: { content: string } };
    expect(cliUser.type).toBe("user");
    expect(cliUser.message.content).toBe("queued hello");

    await closeWebSockets(cli, consumer);
  });

  it("updates and cancels queued message by the same author", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    cli.send(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
        parent_tool_use_id: null,
      }),
    );
    await waitForMessageType(consumer, "status_change");

    consumer.send(JSON.stringify({ type: "queue_message", content: "draft 1" }));
    await waitForMessageType(consumer, "message_queued");

    consumer.send(JSON.stringify({ type: "update_queued_message", content: "draft 2" }));
    const updated = (await waitForMessageType(consumer, "queued_message_updated")) as {
      type: "queued_message_updated";
      content: string;
    };
    expect(updated.content).toBe("draft 2");

    consumer.send(JSON.stringify({ type: "cancel_queued_message" }));
    const cancelled = (await waitForMessageType(consumer, "queued_message_cancelled")) as {
      type: string;
    };
    expect(cancelled.type).toBe("queued_message_cancelled");

    await closeWebSockets(cli, consumer);
  });
});
