import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionManager } from "./helpers/test-utils.js";
import {
  cleanupSessionManager,
  closeWebSockets,
  connectTestCLI,
  connectTestConsumer,
  createTestSession,
  mockSystemInit,
  setupTestSessionManager,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Capabilities Broadcast", () => {
  let tm: TestSessionManager | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionManager(tm);
      tm = undefined;
    }
  });

  it("consumer receives capabilities_ready after CLI system.init", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    cli.send(
      JSON.stringify(
        mockSystemInit(sessionId, {
          slashCommands: [{ name: "/vim", description: "Toggle vim mode" }],
          skills: ["commit"],
        }),
      ),
    );

    const caps = await waitForMessageType(consumer, "capabilities_ready", 10_000);
    expect((caps as { commands?: unknown[] }).commands).toBeDefined();

    await closeWebSockets(cli, consumer);
  });

  it("late-joining consumer receives capabilities_ready", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);

    const consumer1 = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer1, "session_init");
    cli.send(JSON.stringify(mockSystemInit(sessionId)));
    await waitForMessageType(consumer1, "capabilities_ready", 10_000);

    const consumer2 = await connectTestConsumer(port, sessionId);
    const caps = await waitForMessageType(consumer2, "capabilities_ready", 5000);
    expect((caps as { commands?: unknown[] }).commands).toBeDefined();

    await closeWebSockets(cli, consumer1, consumer2);
  });
});
