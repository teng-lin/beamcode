import { afterEach, describe, expect, it } from "vitest";
import type { TestSessionManager } from "./helpers/test-utils.js";
import {
  cleanupSessionManager,
  closeWebSockets,
  connectTestConsumerWithQuery,
  createTestSession,
  setupTestSessionManager,
  waitForMessage,
  waitForMessageType,
} from "./helpers/test-utils.js";

describe("E2E: Presence & RBAC", () => {
  let tm: TestSessionManager | undefined;

  afterEach(async () => {
    if (tm) {
      await cleanupSessionManager(tm);
      tm = undefined;
    }
  });

  it("sends identity with observer role when authenticator marks observer", async () => {
    tm = await setupTestSessionManager({
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

    const identity = (await waitForMessageType(observer, "identity")) as {
      type: "identity";
      role: string;
    };
    expect(identity.type).toBe("identity");
    expect(identity.role).toBe("observer");

    await closeWebSockets(observer);
  });

  it("broadcasts presence_update and supports presence_query", async () => {
    tm = await setupTestSessionManager({
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
    const participant = await connectTestConsumerWithQuery(port, sessionId, {
      role: "participant",
    });
    await waitForMessageType(participant, "identity");
    await waitForMessageType(participant, "session_init");

    const observer = await connectTestConsumerWithQuery(port, sessionId, { role: "observer" });
    await waitForMessageType(observer, "identity");
    await waitForMessageType(observer, "session_init");

    const presence = (await waitForMessage(
      participant,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "presence_update" &&
        Array.isArray((m as { consumers?: unknown[] }).consumers) &&
        (m as { consumers: unknown[] }).consumers.length >= 2,
      5000,
    )) as {
      type: "presence_update";
      consumers: Array<{ role: string }>;
    };
    expect(presence.type).toBe("presence_update");
    expect(presence.consumers.length).toBeGreaterThanOrEqual(2);

    observer.send(JSON.stringify({ type: "presence_query" }));
    const presenceQueryResp = (await waitForMessageType(observer, "presence_update")) as {
      type: "presence_update";
      consumers: Array<{ role: string }>;
    };
    expect(presenceQueryResp.consumers.length).toBeGreaterThanOrEqual(2);

    await closeWebSockets(participant, observer);
  });
});
