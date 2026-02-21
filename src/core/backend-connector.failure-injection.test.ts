import { describe, expect, it, vi } from "vitest";
import { FailureInjectionBackendAdapter } from "../testing/failure-injection-adapter.js";
import { BackendConnector } from "./backend-connector.js";

function createSession(id: string) {
  return {
    id,
    adapterName: undefined,
    backendSession: null,
    backendAbort: null,
    backendSessionId: undefined,
    adapterSupportsSlashPassthrough: false,
    adapterSlashExecutor: null,
    pendingMessages: [],
    pendingPassthroughs: [],
    pendingPermissions: new Map(),
    state: {
      slash_commands: [],
      skills: [],
    },
    registry: {
      registerFromCLI: vi.fn(),
    },
    lastActivity: 0,
  } as any;
}

async function waitForAssertion(assertFn: () => void, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      assertFn();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("BackendConnector failure injection", () => {
  it("emits disconnect and error events when backend stream fails", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const emitEvent = vi.fn();
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any;

    const manager = new BackendConnector({
      adapter,
      adapterResolver: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      metrics: null,
      broadcaster,
      routeUnifiedMessage: vi.fn(),
      emitEvent,
      onBackendConnectedState: (runtimeSession, params) => {
        runtimeSession.backendSession = params.backendSession;
        runtimeSession.backendAbort = params.backendAbort;
        runtimeSession.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
        runtimeSession.adapterSlashExecutor = params.slashExecutor;
      },
      onBackendDisconnectedState: (runtimeSession) => {
        runtimeSession.backendSession = null;
        runtimeSession.backendAbort = null;
        runtimeSession.backendSessionId = undefined;
        runtimeSession.adapterSupportsSlashPassthrough = false;
        runtimeSession.adapterSlashExecutor = null;
      },
      getBackendSession: (runtimeSession) => runtimeSession.backendSession ?? null,
      getBackendAbort: (runtimeSession) => runtimeSession.backendAbort ?? null,
      drainPendingMessages: (runtimeSession) => {
        const pending = runtimeSession.pendingMessages;
        runtimeSession.pendingMessages = [];
        return pending;
      },
      drainPendingPermissionIds: (runtimeSession) => {
        const ids = Array.from(runtimeSession.pendingPermissions.keys());
        runtimeSession.pendingPermissions.clear();
        return ids;
      },
      peekPendingPassthrough: (runtimeSession) => runtimeSession.pendingPassthroughs[0],
      shiftPendingPassthrough: (runtimeSession) => runtimeSession.pendingPassthroughs.shift(),
      setSlashCommandsState: (runtimeSession, commands) => {
        runtimeSession.state = { ...runtimeSession.state, slash_commands: commands };
      },
      registerCLICommands: (runtimeSession, commands) => {
        runtimeSession.registry.registerFromCLI(
          commands.map((name) => ({ name, description: "" })),
        );
      },
    });

    const session = createSession("sess-fi");
    await manager.connectBackend(session);

    adapter.failStream("sess-fi", new Error("Injected stream failure"));

    await waitForAssertion(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        "backend:disconnected",
        expect.objectContaining({ sessionId: "sess-fi" }),
      );
    });

    expect(emitEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        source: "backendConsumption",
        sessionId: "sess-fi",
      }),
    );
    expect(broadcaster.broadcast).toHaveBeenCalledWith(session, { type: "cli_disconnected" });
  });
});
