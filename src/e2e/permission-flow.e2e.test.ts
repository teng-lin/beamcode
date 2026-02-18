import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionManager } from "./helpers/test-utils.js";
import {
  cleanupSessionManager,
  closeWebSockets,
  connectTestCLI,
  connectTestConsumer,
  createTestSession,
  setupTestSessionManager,
  waitForMessage,
  waitForMessageType,
} from "./helpers/test-utils.js";

function mockCliPermissionRequest(requestId = "perm-1") {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls -la" },
      tool_use_id: "tool-use-1",
    },
  };
}

describe("E2E: Permission Flow", () => {
  let tm: TestSessionManager | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionManager(tm);
      tm = undefined;
    }
  });

  it("routes CLI permission request to consumer and consumer allow back to CLI", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);
    const consumer = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer, "session_init");

    const reqId = "perm-allow-1";
    cli.send(JSON.stringify(mockCliPermissionRequest(reqId)));

    const permReq = (await waitForMessageType(consumer, "permission_request")) as {
      type: "permission_request";
      request: { request_id: string; tool_name: string };
    };
    expect(permReq.request.request_id).toBe(reqId);
    expect(permReq.request.tool_name).toBe("Bash");

    consumer.send(
      JSON.stringify({
        type: "permission_response",
        request_id: reqId,
        behavior: "allow",
      }),
    );

    const cliResponse = (await waitForMessage(
      cli,
      (m) =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "control_response",
    )) as { type: string; response: { request_id: string; subtype: string } };

    expect(cliResponse.type).toBe("control_response");
    expect(cliResponse.response.request_id).toBe(reqId);
    expect(cliResponse.response.subtype).toBe("success");

    await closeWebSockets(cli, consumer);
  });

  it("late consumer receives pending permission request", async () => {
    tm = await setupTestSessionManager();
    const { sessionId, port } = createTestSession(tm);
    const cli = await connectTestCLI(port, sessionId);

    const consumer1 = await connectTestConsumer(port, sessionId);
    await waitForMessageType(consumer1, "session_init");

    const reqId = "perm-late-1";
    cli.send(JSON.stringify(mockCliPermissionRequest(reqId)));
    await waitForMessageType(consumer1, "permission_request");

    const consumer2 = await connectTestConsumer(port, sessionId);
    const pending = (await waitForMessageType(consumer2, "permission_request")) as {
      type: "permission_request";
      request: { request_id: string };
    };
    expect(pending.request.request_id).toBe(reqId);

    await closeWebSockets(cli, consumer1, consumer2);
  });
});
