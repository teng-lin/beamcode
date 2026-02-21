import { describe, expect, it, vi } from "vitest";
import type { BackendConnectorDeps } from "./backend-connector.js";
import { BackendConnector } from "./backend-connector.js";

function createDeps(overrides?: Partial<BackendConnectorDeps>): BackendConnectorDeps {
  return {
    adapter: {
      name: "test",
      capabilities: {
        streaming: true,
        permissions: true,
        slashCommands: false,
        availability: "local",
        teams: false,
      },
      connect: vi.fn().mockResolvedValue({
        sessionId: "s1",
        send: vi.fn(),
        sendRaw: vi.fn(),
        messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as any,
    adapterResolver: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    broadcaster: {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any,
    routeUnifiedMessage: vi.fn(),
    emitEvent: vi.fn(),
    onBackendConnectedState: vi.fn(),
    onBackendDisconnectedState: vi.fn(),
    getBackendSession: vi.fn(() => null),
    getBackendAbort: vi.fn(() => null),
    drainPendingMessages: vi.fn(() => []),
    drainPendingPermissionIds: vi.fn(() => []),
    peekPendingPassthrough: vi.fn(() => undefined),
    shiftPendingPassthrough: vi.fn(() => undefined),
    setSlashCommandsState: vi.fn(),
    registerCLICommands: vi.fn(),
    ...overrides,
  };
}

describe("BackendConnector", () => {
  it("delegates lifecycle operations to underlying manager", async () => {
    const deps = createDeps();
    const connector = new BackendConnector(deps);
    const session = { id: "s1", adapterName: undefined } as any;

    expect(connector.hasAdapter).toBe(true);
    await connector.connectBackend(session, { resume: true });
    connector.sendToBackend(session, { type: "interrupt", role: "system", metadata: {} } as any);
    expect(() => connector.isBackendConnected(session)).not.toThrow();
    await connector.disconnectBackend(session);
  });
});
