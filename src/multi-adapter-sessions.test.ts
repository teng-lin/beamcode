import { describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

import type { AdapterResolver } from "./adapters/adapter-resolver.js";
import { ClaudeLauncher } from "./adapters/claude/claude-launcher.js";
import type { CliAdapterName } from "./adapters/create-adapter.js";
import { MemoryStorage } from "./adapters/memory-storage.js";
import type { BackendAdapter } from "./core/interfaces/backend-adapter.js";
import { SessionManager } from "./core/session-manager.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "./interfaces/process-manager.js";
import { MockBackendAdapter } from "./testing/adapter-test-helpers.js";

// ---------------------------------------------------------------------------
// Test ProcessManager
// ---------------------------------------------------------------------------

interface TestProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
}

class TestProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly handles: TestProcessHandle[] = [];
  private alivePids = new Set<number>();
  private nextPid = 30000;

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
  return new ClaudeLauncher({
    processManager: pm,
    config: { port: 3456 },
    storage,
    logger: noopLogger,
  });
}

/** Mock adapter that implements InvertedConnectionAdapter (for Claude). */
class MockInvertedAdapter extends MockBackendAdapter {
  override readonly name = "claude";
  deliverSocket(_sessionId: string, _ws: unknown): boolean {
    return true;
  }
  cancelPending(_sessionId: string): void {}
}

function mockResolver(
  adapters: Record<string, BackendAdapter>,
  defaultName: CliAdapterName = "claude",
): AdapterResolver {
  return {
    resolve: vi.fn((name?: CliAdapterName) => {
      const resolved = name ?? defaultName;
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown adapter: ${resolved}`);
      return adapter;
    }),
    defaultName,
    availableAdapters: ["claude", "codex", "acp", "gemini", "opencode"],
  };
}

// ---------------------------------------------------------------------------
// Integration: Multi-adapter session lifecycle
// ---------------------------------------------------------------------------

describe("multi-adapter session lifecycle", () => {
  it("creates claude and codex sessions, both appear in listSessions, both can be deleted", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const resolver = mockResolver({
      claude: new MockInvertedAdapter(),
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

    // Create one claude and one codex session
    const claudeSession = await mgr.createSession({ cwd: process.cwd() });
    const codexSession = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });

    expect(claudeSession.adapterName).toBe("claude");
    expect(claudeSession.state).toBe("starting");
    expect(codexSession.adapterName).toBe("codex");
    expect(codexSession.state).toBe("connected");

    // Both appear in listSessions
    const sessions = mgr.launcher.listSessions();
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain(claudeSession.sessionId);
    expect(ids).toContain(codexSession.sessionId);

    // Delete the codex session (no PID)
    const codexInfo = mgr.launcher.getSession(codexSession.sessionId);
    expect(codexInfo?.pid).toBeUndefined();
    const codexDeleted = await mgr.deleteSession(codexSession.sessionId);
    expect(codexDeleted).toBe(true);
    expect(mgr.launcher.getSession(codexSession.sessionId)).toBeUndefined();

    // Delete the claude session (has PID)
    const claudeInfo = mgr.launcher.getSession(claudeSession.sessionId);
    expect(claudeInfo?.pid).toBeGreaterThan(0);
    const claudeDeleted = await mgr.deleteSession(claudeSession.sessionId);
    expect(claudeDeleted).toBe(true);
    expect(mgr.launcher.getSession(claudeSession.sessionId)).toBeUndefined();

    // Both gone
    expect(mgr.launcher.listSessions()).toHaveLength(0);

    await mgr.stop();
  });

  it("defaultAdapterName is used when no adapter specified", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const resolver = mockResolver(
      { claude: new MockBackendAdapter(), codex: codexAdapter },
      "codex", // default is codex
    );

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    expect(mgr.defaultAdapterName).toBe("codex");

    // createSession without adapter → uses default (codex)
    const session = await mgr.createSession({ cwd: process.cwd() });
    expect(session.adapterName).toBe("codex");

    await mgr.stop();
  });

  it("codex session connect failure rolls back registration", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const failingAdapter = new MockBackendAdapter();
    failingAdapter.setShouldFail(true);

    const resolver = mockResolver({
      claude: new MockBackendAdapter(),
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

    // Session was cleaned up
    expect(mgr.launcher.listSessions()).toHaveLength(0);

    await mgr.stop();
  });

  it("resolver.resolve('claude') returns claude adapter even when default is different", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const claudeAdapter = new MockBackendAdapter();
    const resolver = mockResolver(
      { claude: claudeAdapter, codex: new MockBackendAdapter() },
      "codex", // default is codex, but claude adapter is still resolvable
    );

    const mgr = new SessionManager({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    // Even with codex as default, resolve("claude") returns the claude adapter
    expect(resolver.resolve("claude")).toBe(claudeAdapter);

    await mgr.stop();
  });
});
