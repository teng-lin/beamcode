import { describe, expect, it, vi } from "vitest";
import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import { BackendConnector } from "./backend-connector.js";
import type { BackendAdapter, BackendSession } from "./interfaces/backend-adapter.js";

function mockAdapter(name: string): BackendAdapter {
  return {
    name,
    capabilities: {
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
      teams: false,
    },
    connect: vi.fn().mockResolvedValue({
      sessionId: "test-session",
      send: vi.fn(),
      sendRaw: vi.fn(),
      messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendSession),
  };
}

function mockResolver(adapters: Record<string, BackendAdapter>): AdapterResolver {
  const claude = adapters.claude ?? mockAdapter("claude");
  return {
    resolve: vi.fn((name) => {
      const resolved = name ?? "claude";
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown adapter: ${resolved}`);
      return adapter;
    }),
    defaultName: "claude" as any,
    availableAdapters: ["claude", "codex", "acp", "gemini", "opencode"] as any,
  };
}

describe("BackendConnector per-session adapter", () => {
  const baseDeps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    broadcaster: { broadcast: vi.fn(), sendTo: vi.fn() } as any,
    routeUnifiedMessage: vi.fn(),
    emitEvent: vi.fn(),
    onBackendConnectedState: (session: any, params: any) => {
      session.backendSession = params.backendSession;
      session.backendAbort = params.backendAbort;
      session.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
      session.adapterSlashExecutor = params.slashExecutor;
    },
    onBackendDisconnectedState: (session: any) => {
      session.backendSession = null;
      session.backendAbort = null;
      session.backendSessionId = undefined;
      session.adapterSupportsSlashPassthrough = false;
      session.adapterSlashExecutor = null;
    },
    getBackendSession: (session: any) => session.backendSession ?? null,
    getBackendAbort: (session: any) => session.backendAbort ?? null,
    drainPendingMessages: (session: any) => {
      const pending = session.pendingMessages ?? [];
      session.pendingMessages = [];
      return pending;
    },
    drainPendingPermissionIds: (session: any) => {
      const pendingPermissions = session.pendingPermissions ?? new Map();
      const ids = Array.from(pendingPermissions.keys());
      pendingPermissions.clear();
      session.pendingPermissions = pendingPermissions;
      return ids;
    },
    peekPendingPassthrough: (session: any) => session.pendingPassthroughs?.[0],
    shiftPendingPassthrough: (session: any) => session.pendingPassthroughs?.shift(),
    setSlashCommandsState: (session: any, commands: string[]) => {
      session.state = { ...(session.state ?? {}), slash_commands: commands };
    },
    registerCLICommands: (session: any, commands: string[]) => {
      session.registry?.registerFromCLI?.(
        commands.map((name: string) => ({ name, description: "" })),
      );
    },
  };

  it("resolves adapter from resolver using session.adapterName", async () => {
    const codex = mockAdapter("codex");
    const resolver = mockResolver({ codex, claude: mockAdapter("claude") });
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: null,
      adapterResolver: resolver,
    });

    const session = {
      id: "s1",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await blm.connectBackend(session);
    expect(resolver.resolve).toHaveBeenCalledWith("codex");
    expect(codex.connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
  });

  it("falls back to global adapter when no adapterName", async () => {
    const globalAdapter = mockAdapter("claude");
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: globalAdapter,
      adapterResolver: null,
    });

    const session = {
      id: "s2",
      adapterName: undefined,
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await blm.connectBackend(session);
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("falls back to global adapter when adapterName is set but no resolver", async () => {
    const globalAdapter = mockAdapter("claude");
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: globalAdapter,
      adapterResolver: null,
    });

    const session = {
      id: "s3",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await blm.connectBackend(session);
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("falls back to global adapter for invalid adapterName", async () => {
    const globalAdapter = mockAdapter("claude");
    const resolver = mockResolver({ claude: mockAdapter("claude") });
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: globalAdapter,
      adapterResolver: resolver,
    });

    const session = {
      id: "s4",
      adapterName: "bogus-invalid",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await blm.connectBackend(session);
    expect(baseDeps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid adapter name"),
    );
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("hasAdapter is true when resolver is set", () => {
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: null,
      adapterResolver: mockResolver({ claude: mockAdapter("claude") }),
    });
    expect(blm.hasAdapter).toBe(true);
  });

  it("hasAdapter is true when global adapter is set", () => {
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: mockAdapter("claude"),
      adapterResolver: null,
    });
    expect(blm.hasAdapter).toBe(true);
  });

  it("hasAdapter is false when neither resolver nor adapter is set", () => {
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: null,
      adapterResolver: null,
    });
    expect(blm.hasAdapter).toBe(false);
  });

  it("throws when no adapter or resolver is configured", async () => {
    const blm = new BackendConnector({
      ...baseDeps,
      adapter: null,
      adapterResolver: null,
    });

    const session = {
      id: "s5",
      adapterName: undefined,
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await expect(blm.connectBackend(session)).rejects.toThrow("No BackendAdapter configured");
  });

  it("uses setSlashCommandsState callback when slash executor is available", async () => {
    const sessionImpl = {
      sessionId: "test-session",
      send: vi.fn(),
      sendRaw: vi.fn(),
      messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendSession;

    const adapter: BackendAdapter = {
      name: "codex",
      capabilities: {
        streaming: true,
        permissions: true,
        slashCommands: true,
        availability: "local",
        teams: false,
      },
      connect: vi.fn().mockResolvedValue(sessionImpl),
      createSlashExecutor: () => ({
        handles: () => true,
        execute: vi.fn(async () => null),
        supportedCommands: () => ["/compact", "/status"],
      }),
    };

    const setSlashCommandsState = vi.fn();
    const blm = new BackendConnector({
      ...baseDeps,
      adapter,
      adapterResolver: null,
      setSlashCommandsState,
    });

    const session = {
      id: "s6",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
      pendingPermissions: new Map(),
      pendingPassthroughs: [],
      state: { slash_commands: [] },
      registry: { registerFromCLI: vi.fn() },
    } as any;

    await blm.connectBackend(session);

    expect(setSlashCommandsState).toHaveBeenCalledWith(session, ["/compact", "/status"]);
    expect(session.state.slash_commands).toEqual([]);
    expect(session.registry.registerFromCLI).toHaveBeenCalledWith([
      { name: "/compact", description: "" },
      { name: "/status", description: "" },
    ]);
  });
});
