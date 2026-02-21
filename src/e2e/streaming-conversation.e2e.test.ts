import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionCoordinator } from "./helpers/test-utils.js";
import {
  cleanupSessionCoordinator,
  closeWebSockets,
  connectTestCLI,
  connectTestConsumer,
  createTestSession,
  mockAssistantMessage,
  mockResultMessage,
  setupTestSessionCoordinator,
  waitForMessage,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Streaming Conversation", () => {
  let tm: TestSessionCoordinator | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionCoordinator(tm);
      tm = undefined;
    }
  });

  it("forwards stream_event deltas from CLI to consumer", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    cli.send(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello " },
        },
        parent_tool_use_id: null,
      }),
    );

    const stream = (await waitForMessageType(consumer, "stream_event")) as {
      type: "stream_event";
      event: { delta?: { text?: string } };
    };
    expect(stream.event.delta?.text).toBe("Hello ");

    await closeWebSockets(cli, consumer);
  });

  it("supports two-turn conversation ordering", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    // Turn 1
    consumer.send(JSON.stringify({ type: "user_message", content: "Turn 1?" }));
    const cliUser1 = (await waitForMessage(
      cli,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "user" &&
        (m as { message?: { content?: string } }).message?.content === "Turn 1?",
    )) as { type: string };
    expect(cliUser1.type).toBe("user");

    cli.send(JSON.stringify(mockAssistantMessage("Answer 1", "a1")));
    cli.send(JSON.stringify(mockResultMessage(sessionId, { text: "done-1" })));
    const assistant1 = (await waitForMessageType(consumer, "assistant")) as {
      message: { content: Array<{ text: string }> };
    };
    expect(assistant1.message.content[0].text).toBe("Answer 1");
    const result1 = (await waitForMessageType(consumer, "result")) as {
      data?: { result?: string };
    };
    expect(result1.data?.result).toBe("done-1");

    // Turn 2
    consumer.send(JSON.stringify({ type: "user_message", content: "Turn 2?" }));
    const cliUser2 = (await waitForMessage(
      cli,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "user" &&
        (m as { message?: { content?: string } }).message?.content === "Turn 2?",
    )) as { type: string };
    expect(cliUser2.type).toBe("user");

    cli.send(JSON.stringify(mockAssistantMessage("Answer 2", "a2")));
    cli.send(JSON.stringify(mockResultMessage(sessionId, { text: "done-2" })));
    const assistant2 = (await waitForMessageType(consumer, "assistant")) as {
      message: { content: Array<{ text: string }> };
    };
    expect(assistant2.message.content[0].text).toBe("Answer 2");
    const result2 = (await waitForMessageType(consumer, "result")) as {
      data?: { result?: string };
    };
    expect(result2.data?.result).toBe("done-2");

    await closeWebSockets(cli, consumer);
  });
});
