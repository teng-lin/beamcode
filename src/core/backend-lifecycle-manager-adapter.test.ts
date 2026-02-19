import { describe, expect, it, vi } from "vitest";
import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import { BackendLifecycleManager } from "./backend-lifecycle-manager.js";
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
    claudeAdapter: claude as any,
    defaultName: "claude" as any,
    availableAdapters: ["claude", "codex", "acp", "gemini", "opencode"] as any,
  };
}

describe("BackendLifecycleManager per-session adapter", () => {
  const baseDeps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    broadcaster: { broadcast: vi.fn(), sendTo: vi.fn() } as any,
    routeUnifiedMessage: vi.fn(),
    emitEvent: vi.fn(),
  };

  it("resolves adapter from resolver using session.adapterName", async () => {
    const codex = mockAdapter("codex");
    const resolver = mockResolver({ codex, claude: mockAdapter("claude") });
    const blm = new BackendLifecycleManager({
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
    const blm = new BackendLifecycleManager({
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
    const blm = new BackendLifecycleManager({
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
    const blm = new BackendLifecycleManager({
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
    const blm = new BackendLifecycleManager({
      ...baseDeps,
      adapter: null,
      adapterResolver: mockResolver({ claude: mockAdapter("claude") }),
    });
    expect(blm.hasAdapter).toBe(true);
  });

  it("hasAdapter is true when global adapter is set", () => {
    const blm = new BackendLifecycleManager({
      ...baseDeps,
      adapter: mockAdapter("claude"),
      adapterResolver: null,
    });
    expect(blm.hasAdapter).toBe(true);
  });

  it("hasAdapter is false when neither resolver nor adapter is set", () => {
    const blm = new BackendLifecycleManager({
      ...baseDeps,
      adapter: null,
      adapterResolver: null,
    });
    expect(blm.hasAdapter).toBe(false);
  });

  it("throws when no adapter or resolver is configured", async () => {
    const blm = new BackendLifecycleManager({
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
});
