import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionCoordinator } from "./helpers/test-utils.js";
import {
  cleanupSessionCoordinator,
  closeWebSockets,
  connectTestCLI,
  connectTestConsumer,
  createTestSession,
  setupTestSessionCoordinator,
  waitForMessage,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Session Status", () => {
  let tm: TestSessionCoordinator | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionCoordinator(tm);
      tm = undefined;
    }
  });

  it("broadcasts running status from stream message_start", async () => {
    tm = await setupTestSessionCoordinator();
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

    const status = (await waitForMessageType(consumer, "status_change")) as {
      type: "status_change";
      status: string | null;
    };
    expect(status.status).toBe("running");

    await closeWebSockets(cli, consumer);
  });

  it("forwards explicit compacting status from CLI", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    cli.send(
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
        session_id: sessionId,
        uuid: "status-1",
      }),
    );

    const status = (await waitForMessageType(consumer, "status_change")) as {
      type: "status_change";
      status: string | null;
    };
    expect(status.status).toBe("compacting");

    await closeWebSockets(cli, consumer);
  });

  it("forwards interrupt from consumer to CLI as control_request", async () => {
    tm = await setupTestSessionCoordinator();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    consumer.send(JSON.stringify({ type: "interrupt" }));
    const controlReq = (await waitForMessage(
      cli,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string; request?: { subtype?: string } }).type === "control_request" &&
        (m as { request?: { subtype?: string } }).request?.subtype === "interrupt",
    )) as { type: string; request: { subtype: string } };

    expect(controlReq.type).toBe("control_request");
    expect(controlReq.request.subtype).toBe("interrupt");

    await closeWebSockets(cli, consumer);
  });
});
