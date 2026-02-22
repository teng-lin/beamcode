import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../types/session-state.js";
import { StartupRestoreService } from "./startup-restore-service.js";

function makeDeps(overrides?: { registrySameAsLauncher?: boolean; sessions?: SessionInfo[] }) {
  const callOrder: string[] = [];
  const launcher = {
    restoreFromStorage: vi.fn(() => {
      callOrder.push("launcher");
      return 2;
    }),
  };
  const sessions: SessionInfo[] = overrides?.sessions ?? [];
  const registry = overrides?.registrySameAsLauncher
    ? (launcher as unknown as typeof registryObj)
    : (() => {
        const r = {
          restoreFromStorage: vi.fn(() => {
            callOrder.push("registry");
            return 1;
          }),
          listSessions: vi.fn(() => sessions),
        };
        return r;
      })();

  const registryObj = {
    restoreFromStorage: vi.fn(() => {
      callOrder.push("registry");
      return 1;
    }),
    listSessions: vi.fn(() => sessions),
  };

  // If registrySameAsLauncher, registry IS launcher (so the identity check passes).
  // Otherwise use a separate registry mock.
  const actualRegistry = overrides?.registrySameAsLauncher ? launcher : registry;

  // Patch listSessions onto launcher when they are the same object
  if (overrides?.registrySameAsLauncher) {
    (launcher as Record<string, unknown>).listSessions = vi.fn(() => sessions);
  }

  const bridge = {
    restoreFromStorage: vi.fn(() => {
      callOrder.push("bridge");
      return 3;
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return {
    launcher,
    registry: actualRegistry as {
      restoreFromStorage?(): number;
      listSessions(): SessionInfo[];
    },
    bridge,
    logger,
    callOrder,
  };
}

function makeSession(partial: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "s-1",
    state: "connected",
    cwd: "/tmp",
    createdAt: Date.now(),
    ...partial,
  };
}

describe("StartupRestoreService", () => {
  it("restores in order: launcher → registry → bridge", () => {
    const deps = makeDeps();
    const service = new StartupRestoreService(deps);

    service.restore();

    expect(deps.callOrder).toEqual(["launcher", "registry", "bridge"]);
  });

  it("skips registry.restoreFromStorage when registry === launcher", () => {
    const deps = makeDeps({ registrySameAsLauncher: true });
    const service = new StartupRestoreService(deps);

    const result = service.restore();

    expect(deps.callOrder).toEqual(["launcher", "bridge"]);
    expect(result.registry).toBe(0);
  });

  it("returns correct counts", () => {
    const deps = makeDeps();
    const service = new StartupRestoreService(deps);

    const result = service.restore();

    expect(result.launcher).toBe(2);
    expect(result.registry).toBe(1);
    expect(result.bridge).toBe(3);
  });

  it("marks direct-connection sessions (has adapterName, no pid, not archived) as exited", () => {
    const directSession = makeSession({
      sessionId: "direct-1",
      adapterName: "gemini",
      state: "connected",
    });
    const invertedSession = makeSession({
      sessionId: "inverted-1",
      pid: 12345,
      adapterName: "claude",
      state: "connected",
    });
    const archivedSession = makeSession({
      sessionId: "archived-1",
      adapterName: "codex",
      archived: true,
      state: "connected",
    });
    const noAdapterSession = makeSession({
      sessionId: "no-adapter",
      state: "connected",
    });

    const deps = makeDeps({
      sessions: [directSession, invertedSession, archivedSession, noAdapterSession],
    });
    const service = new StartupRestoreService(deps);

    const result = service.restore();

    // Only directSession should be marked as "exited"
    expect(directSession.state).toBe("exited");
    expect(invertedSession.state).toBe("connected");
    expect(archivedSession.state).toBe("connected");
    expect(noAdapterSession.state).toBe("connected");
    expect(result.directConnectionsMarked).toBe(1);
  });

  it("logs restoration counts when > 0", () => {
    const deps = makeDeps();
    const service = new StartupRestoreService(deps);

    service.restore();

    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("Restored 2 launcher"));
  });

  it("does not log when nothing was restored", () => {
    const deps = makeDeps();
    deps.launcher.restoreFromStorage.mockReturnValue(0);
    (
      deps.registry as { restoreFromStorage: ReturnType<typeof vi.fn> }
    ).restoreFromStorage!.mockReturnValue(0);
    deps.bridge.restoreFromStorage.mockReturnValue(0);
    const service = new StartupRestoreService(deps);

    service.restore();

    // Should not log the "Restored ..." message
    const infoCalls = deps.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    const restoreLogCalls = infoCalls.filter((msg: string) => msg.startsWith("Restored"));
    expect(restoreLogCalls).toHaveLength(0);
  });

  it("handles registry without restoreFromStorage method", () => {
    const callOrder: string[] = [];
    const launcher = {
      restoreFromStorage: vi.fn(() => {
        callOrder.push("launcher");
        return 1;
      }),
    };
    const registry = {
      // No restoreFromStorage method
      listSessions: vi.fn(() => []),
    };
    const bridge = {
      restoreFromStorage: vi.fn(() => {
        callOrder.push("bridge");
        return 2;
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const service = new StartupRestoreService({ launcher, registry, bridge, logger });
    const result = service.restore();

    expect(callOrder).toEqual(["launcher", "bridge"]);
    expect(result.registry).toBe(0);
    expect(result.launcher).toBe(1);
    expect(result.bridge).toBe(2);
  });
});
