import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makeAssistantUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  noopLogger,
  setupInitializedSession,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge", () => {
  let bridge: SessionBridge;
  let storage: MemoryStorage;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    storage = created.storage;
    adapter = created.adapter;
  });
  describe("backend:* events", () => {
    it("emits backend:connected on connectBackend", async () => {
      bridge.getOrCreateSession("sess-1");
      const backendHandler = vi.fn();
      bridge.on("backend:connected", backendHandler);

      await bridge.connectBackend("sess-1");

      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("emits backend:disconnected on disconnectBackend", async () => {
      await bridge.connectBackend("sess-1");

      const backendHandler = vi.fn();
      bridge.on("backend:disconnected", backendHandler);

      await bridge.disconnectBackend("sess-1");

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "normal",
      });
    });

    it("emits backend:session_id on system init", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const backendHandler = vi.fn();
      bridge.on("backend:session_id", backendHandler);

      backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-abc" }));
      await tick();

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        backendSessionId: "cli-abc",
      });
    });

    it("emits backend:relaunch_needed when consumer opens and backend is dead", () => {
      bridge.getOrCreateSession("sess-1");
      const backendHandler = vi.fn();
      bridge.on("backend:relaunch_needed", backendHandler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("does not emit backend:relaunch_needed when backend is connected", async () => {
      await bridge.connectBackend("sess-1");

      const handler = vi.fn();
      bridge.on("backend:relaunch_needed", handler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── Error path coverage (Task 11) ─────────────────────────────────────

  describe("error paths", () => {
    it("handleConsumerMessage exceeding MAX_CONSUMER_MESSAGE_SIZE closes socket with 1009", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // 256KB + 1
      const oversized = "x".repeat(262_145);
      bridge.handleConsumerMessage(ws, "sess-1", oversized);

      expect(ws.close).toHaveBeenCalledWith(1009, "Message Too Big");
    });

    it("messages queue when backend is not connected and flush on connect", async () => {
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Send a consumer message without backend being connected
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      // Connect backend and check flush
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // After backend connects, queued messages should have been flushed via send()
      const flushed = backendSession.sentMessages.some((m) => m.type === "user_message");
      expect(flushed).toBe(true);
    });

    it("consumer open with unknown session auto-creates the session", () => {
      const ws = createMockSocket();

      // No backend has connected to "new-session" yet
      bridge.handleConsumerOpen(ws, authContext("new-session"));

      // Session should be auto-created
      const snapshot = bridge.getSession("new-session");
      expect(snapshot).toBeDefined();
      expect(snapshot!.consumerCount).toBe(1);
    });

    it("consumer message for session with no backend does not crash", () => {
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("no-cli"));

      // Try to send a message without any backend
      expect(() => {
        bridge.handleConsumerMessage(
          ws,
          "no-cli",
          JSON.stringify({ type: "user_message", content: "test" }),
        );
      }).not.toThrow();
    });
  });

  // ── seedSessionState ────────────────────────────────────────────────────

  describe("seedSessionState", () => {
    it("populates cwd and model on session state", () => {
      bridge.seedSessionState("seed-1", { cwd: "/home/user/project", model: "opus" });
      const snap = bridge.getSession("seed-1");
      expect(snap).toBeDefined();
      expect(snap!.state.cwd).toBe("/home/user/project");
      expect(snap!.state.model).toBe("opus");
    });

    it("resolves git info when gitResolver is provided", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "feat/test",
          isWorktree: true,
          repoRoot: "/repo",
          ahead: 2,
          behind: 1,
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.seedSessionState("seed-2", { cwd: "/repo", model: "sonnet" });

      const snap = gitBridge.getSession("seed-2");
      expect(snap!.state.git_branch).toBe("feat/test");
      expect(snap!.state.is_worktree).toBe(true);
      expect(snap!.state.repo_root).toBe("/repo");
      expect(snap!.state.git_ahead).toBe(2);
      expect(snap!.state.git_behind).toBe(1);
      expect(mockGitResolver.resolve).toHaveBeenCalledWith("/repo");
    });

    it("does not overwrite cwd or model when params are undefined", () => {
      bridge.seedSessionState("seed-3", { cwd: "/first", model: "opus" });
      bridge.seedSessionState("seed-3", {});

      const snap = bridge.getSession("seed-3");
      expect(snap!.state.cwd).toBe("/first");
      expect(snap!.state.model).toBe("opus");
    });

    it("is idempotent: second call does not re-resolve git info", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.seedSessionState("seed-4", { cwd: "/repo" });
      gitBridge.seedSessionState("seed-4", { cwd: "/repo" });

      // resolve called only once -- second call skips due to git_branch already set
      expect(mockGitResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("does not spawn subprocesses repeatedly for non-git directories", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue(null), // non-git dir
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.seedSessionState("seed-5", { cwd: "/tmp" });
      // Simulate consumer connecting
      const ws = createMockSocket();
      gitBridge.handleConsumerOpen(ws, authContext("seed-5"));

      // resolve called only once -- second call skipped due to attempt tracking
      expect(mockGitResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("does not crash when gitResolver.resolve() throws", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockImplementation(() => {
          throw new Error("git not found");
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      expect(() => {
        gitBridge.seedSessionState("seed-6", { cwd: "/repo" });
      }).not.toThrow();

      const snap = gitBridge.getSession("seed-6");
      expect(snap!.state.cwd).toBe("/repo");
      expect(snap!.state.git_branch).toBe("");
    });

    it("consumer connecting before backend receives seeded state in session_init", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "develop",
          isWorktree: false,
          repoRoot: "/project",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      // Seed state (simulating launcher.launch + seedSessionState)
      gitBridge.seedSessionState("seed-7", { cwd: "/project", model: "opus" });

      // Consumer connects before backend
      const ws = createMockSocket();
      gitBridge.handleConsumerOpen(ws, authContext("seed-7"));

      // Consumer should receive session_init with seeded state
      const parsed = ws.sentMessages.map((m: string) => JSON.parse(m));
      const initMsg = parsed.find((m: any) => m.type === "session_init");
      expect(initMsg).toBeDefined();
      expect(initMsg.session.cwd).toBe("/project");
      expect(initMsg.session.model).toBe("opus");
      expect(initMsg.session.git_branch).toBe("develop");
    });
  });

});
