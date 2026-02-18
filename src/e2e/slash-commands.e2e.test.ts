import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionManager } from "./helpers/test-utils.js";
import {
  cleanupSessionManager,
  closeWebSockets,
  connectTestConsumer,
  createTestSession,
  mockSlashCommand,
  sendAndWait,
  setupTestSessionManager,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Slash Commands", () => {
  let tm: TestSessionManager | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionManager(tm);
      tm = undefined;
    }
  });

  it("/help returns slash_command_result without requiring a CLI connection", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    const result = await sendAndWait(
      consumer,
      consumer,
      mockSlashCommand("/help"),
      "slash_command_result",
    );

    const parsed = result as { command: string; source: string; content: string };
    expect(parsed.command).toBe("/help");
    expect(parsed.source).toBe("emulated");
    expect(parsed.content).toContain("/help");
    expect(parsed.content).toContain("/compact");
    expect(parsed.content).toContain("/cost");

    await closeWebSockets(consumer);
  });

  it("/help echoes request_id in slash_command_result", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    const result = await sendAndWait(
      consumer,
      consumer,
      mockSlashCommand("/help", "req-42"),
      "slash_command_result",
    );

    expect((result as { request_id: string }).request_id).toBe("req-42");
    await closeWebSockets(consumer);
  });
});
