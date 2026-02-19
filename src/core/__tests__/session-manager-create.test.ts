import { describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

import type { AdapterResolver } from "../../adapters/adapter-resolver.js";
import type { CliAdapterName } from "../../adapters/create-adapter.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { SdkUrlLauncher } from "../../adapters/sdk-url/sdk-url-launcher.js";
import type {
  ProcessHandle,
  ProcessManager,
  SpawnOptions,
} from "../../interfaces/process-manager.js";
import { MockBackendAdapter } from "../../testing/adapter-test-helpers.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import { SessionManager } from "../session-manager.js";

// ---------------------------------------------------------------------------
// Minimal ProcessManager mock
// ---------------------------------------------------------------------------

interface TestProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
}

class TestProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly handles: TestProcessHandle[] = [];
  private alivePids = new Set<number>();
  private nextPid = 20000;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    const pid = this.nextPid++;
    this.alivePids.add(pid);
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const handle: TestProcessHandle = {
      pid,
      exited,
      kill: () => {
        this.alivePids.delete(pid);
        resolveExit!(0);
      },
      stdout: null,
      stderr: null,
      resolveExit: (code: number | null) => {
        this.alivePids.delete(pid);
        resolveExit!(code);
      },
    };
    this.handles.push(handle);
    return handle;
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function createLauncher(pm: ProcessManager, storage?: MemoryStorage) {
  return new SdkUrlLauncher({
    processManager: pm,
    config: { port: 3456 },
    storage,
    logger: noopLogger,
  });
}

function mockResolver(
  adapters: Record<string, BackendAdapter>,
  defaultName: CliAdapterName = "sdk-url",
): AdapterResolver {
  const sdkUrl = adapters["sdk-url"] ?? new MockBackendAdapter();
  return {
    resolve: vi.fn((name?: CliAdapterName) => {
      const resolved = name ?? defaultName;
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown adapter: ${resolved}`);
      return adapter;
    }),
    sdkUrlAdapter: sdkUrl as any,
    defaultName,
    availableAdapters: ["sdk-url", "codex", "acp"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager.createSession", () => {
  it("for sdk-url: delegates to launcher.launch()", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: process.cwd() });

    expect(result.sessionId).toBeTruthy();
    expect(result.cwd).toBe(process.cwd());
    expect(result.adapterName).toBe("sdk-url");
    expect(result.state).toBe("starting");
    expect(result.createdAt).toBeGreaterThan(0);

    // Verify it appears in launcher
    const sessions = mgr.launcher.listSessions();
    expect(sessions.find((s) => s.sessionId === result.sessionId)).toBeDefined();

    await mgr.stop();
  });

  it("for codex: registers in launcher, connects via bridge", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const connectSpy = vi.spyOn(codexAdapter, "connect");
    const resolver = mockResolver({
      "sdk-url": new MockBackendAdapter(),
      codex: codexAdapter,
    });

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.adapterName).toBe("codex");
    expect(result.state).toBe("connected");

    // Verify in launcher
    const sessions = mgr.launcher.listSessions();
    expect(sessions.find((s) => s.sessionId === result.sessionId)).toBeDefined();

    // Verify adapter.connect was called
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: result.sessionId }),
    );

    await mgr.stop();
  });

  it("both sdk-url and codex sessions appear in listSessions", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const resolver = mockResolver({
      "sdk-url": new MockBackendAdapter(),
      codex: codexAdapter,
    });

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const sdkResult = await mgr.createSession({ cwd: process.cwd() });
    const codexResult = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });

    const sessions = mgr.launcher.listSessions();
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain(sdkResult.sessionId);
    expect(ids).toContain(codexResult.sessionId);

    await mgr.stop();
  });

  it("on connect failure for non-sdk-url: cleans up registered session", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const failingAdapter = new MockBackendAdapter();
    failingAdapter.setShouldFail(true);

    const resolver = mockResolver({
      "sdk-url": new MockBackendAdapter(),
      codex: failingAdapter,
    });

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    await expect(mgr.createSession({ cwd: process.cwd(), adapterName: "codex" })).rejects.toThrow(
      "Connection failed",
    );

    // Verify the orphaned session was cleaned up
    const sessions = mgr.launcher.listSessions();
    expect(sessions).toHaveLength(0);

    await mgr.stop();
  });

  it("uses defaultAdapterName when none specified", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const connectSpy = vi.spyOn(codexAdapter, "connect");
    const resolver = mockResolver(
      { "sdk-url": new MockBackendAdapter(), codex: codexAdapter },
      "codex",
    );

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: process.cwd() });

    expect(result.adapterName).toBe("codex");
    expect(connectSpy).toHaveBeenCalled();

    await mgr.stop();
  });
});

describe("SessionManager.deleteSession", () => {
  it("deletes session with a PID (sdk-url)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: process.cwd() });
    const deleted = await mgr.deleteSession(result.sessionId);

    expect(deleted).toBe(true);
    expect(mgr.launcher.getSession(result.sessionId)).toBeUndefined();
  });

  it("deletes session without a PID (non-sdk-url)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const resolver = mockResolver({
      "sdk-url": new MockBackendAdapter(),
      codex: codexAdapter,
    });

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });
    const deleted = await mgr.deleteSession(result.sessionId);

    expect(deleted).toBe(true);
    expect(mgr.launcher.getSession(result.sessionId)).toBeUndefined();
  });

  it("returns false for non-existent session", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const deleted = await mgr.deleteSession("nonexistent-id");

    expect(deleted).toBe(false);

    await mgr.stop();
  });
});
