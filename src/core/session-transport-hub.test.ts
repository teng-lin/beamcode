import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTransportHubDeps } from "./interfaces/session-coordinator-coordination.js";
import { SessionTransportHub } from "./session-transport-hub.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSocket() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    bufferedAmount: 42,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    }),
    _handlers: handlers,
    _emit(event: string, ...args: unknown[]) {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };
}

function createMockDeps(overrides: Partial<SessionTransportHubDeps> = {}): SessionTransportHubDeps {
  return {
    bridge: {
      handleConsumerOpen: vi.fn(),
      handleConsumerMessage: vi.fn(),
      handleConsumerClose: vi.fn(),
      setAdapterName: vi.fn(),
      connectBackend: vi.fn().mockResolvedValue(undefined),
    },
    launcher: {
      getSession: vi.fn().mockReturnValue(undefined),
    } as any,
    adapter: null,
    adapterResolver: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    server: null,
    port: 3456,
    toAdapterSocket: vi.fn((s) => s as any),
    ...overrides,
  };
}

function makeInvertedAdapter(deliverResult = true) {
  return {
    name: "claude",
    capabilities: {
      streaming: true,
      permissions: true,
      slashCommands: true,
      availability: "local",
      teams: false,
    },
    connect: vi.fn(),
    deliverSocket: vi.fn().mockReturnValue(deliverResult),
    cancelPending: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionTransportHub", () => {
  let deps: SessionTransportHubDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
  });

  // ── start / stop ────────────────────────────────────────────────────────

  describe("start / stop", () => {
    it("is a no-op when no server is set", async () => {
      const hub = new SessionTransportHub(deps);
      await expect(hub.start()).resolves.not.toThrow();
      await expect(hub.stop()).resolves.not.toThrow();
    });

    it("calls listen on start and close on stop when server is set", async () => {
      const server = {
        listen: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      deps = createMockDeps({ server });
      const hub = new SessionTransportHub(deps);

      await hub.start();
      expect(server.listen).toHaveBeenCalledOnce();
      expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("listening"));

      await hub.stop();
      expect(server.close).toHaveBeenCalledOnce();
    });
  });

  // ── setServer ──────────────────────────────────────────────────────────

  describe("setServer", () => {
    it("replaces the server reference so subsequent start uses new server", async () => {
      // Create hub with no server — start() is a no-op
      const depsNoServer = createMockDeps({ server: null as any });
      const hub = new SessionTransportHub(depsNoServer);
      await hub.start(); // no-op, no server

      const newServer = {
        listen: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      hub.setServer(newServer);

      // After setServer, start() should use the new server
      await hub.start();
      expect(newServer.listen).toHaveBeenCalledOnce();
    });
  });

  // ── handleCliConnection ────────────────────────────────────────────────

  describe("handleCliConnection", () => {
    let capturedOnCLI: (socket: any, sessionId: string) => void;
    let capturedOnConsumer: (socket: any, context: any) => void;

    function setupServer(overrides: Partial<SessionTransportHubDeps> = {}) {
      const server = {
        listen: vi.fn(async (onCli: any, onConsumer: any) => {
          capturedOnCLI = onCli;
          capturedOnConsumer = onConsumer;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      deps = createMockDeps({ server, ...overrides });
      return new SessionTransportHub(deps);
    }

    it("closes socket when no adapter is configured", async () => {
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      };
      const hub = setupServer({ launcher: launcher as any });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      expect(socket.close).toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("No adapter"));
    });

    it("closes socket when session state is wrong (not starting)", async () => {
      const adapter = makeInvertedAdapter();
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "connected" }),
      };
      const hub = setupServer({ adapter: adapter as any, launcher: launcher as any });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      expect(socket.close).toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rejecting"));
    });

    it("closes socket when session does not exist", async () => {
      const adapter = makeInvertedAdapter();
      const launcher = {
        getSession: vi.fn().mockReturnValue(undefined),
      };
      const hub = setupServer({ adapter: adapter as any, launcher: launcher as any });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "unknown-sess");

      expect(socket.close).toHaveBeenCalled();
    });

    it("delivers socket on successful connection", async () => {
      const adapter = makeInvertedAdapter(true);
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      };
      const hub = setupServer({ adapter: adapter as any, launcher: launcher as any });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      // Wait for async connectBackend + deliverSocket chain
      await vi.waitFor(() => {
        expect(adapter.deliverSocket).toHaveBeenCalled();
      });

      expect(deps.bridge.setAdapterName).toHaveBeenCalledWith("sess-1", "claude");
      expect(deps.bridge.connectBackend).toHaveBeenCalledWith("sess-1");
      expect(socket.close).not.toHaveBeenCalled();
    });

    it("closes socket and cancels pending when deliverSocket returns false", async () => {
      const adapter = makeInvertedAdapter(false);
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      };
      const hub = setupServer({ adapter: adapter as any, launcher: launcher as any });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(adapter.deliverSocket).toHaveBeenCalled();
      });

      expect(adapter.cancelPending).toHaveBeenCalledWith("sess-1");
      expect(socket.close).toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to deliver"));
    });

    it("closes socket and cancels pending when connectBackend throws", async () => {
      const adapter = makeInvertedAdapter();
      const bridge = {
        ...deps.bridge,
        connectBackend: vi.fn().mockRejectedValue(new Error("connect failed")),
        setAdapterName: vi.fn(),
      };
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      };
      const hub = setupServer({
        adapter: adapter as any,
        launcher: launcher as any,
        bridge: bridge as any,
      });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(adapter.cancelPending).toHaveBeenCalledWith("sess-1");
      });

      expect(socket.close).toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect backend"),
      );
    });

    it("uses adapterResolver.resolve() to find inverted adapter from session info", async () => {
      const resolverAdapter = makeInvertedAdapter(true);
      const adapterResolver = {
        resolve: vi.fn().mockReturnValue(resolverAdapter),
        defaultName: "codex" as const,
        availableAdapters: [],
      };
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting", adapterName: "claude" }),
      };
      const hub = setupServer({
        adapter: null,
        adapterResolver: adapterResolver as any,
        launcher: launcher as any,
      });
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(resolverAdapter.deliverSocket).toHaveBeenCalled();
      });
      expect(adapterResolver.resolve).toHaveBeenCalledWith("claude");
    });
  });

  // ── Message buffering and replay ───────────────────────────────────────

  describe("message buffering and replay", () => {
    let capturedOnCLI: (socket: any, sessionId: string) => void;

    function setupForBuffering() {
      const adapter = makeInvertedAdapter(true);
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      };
      const server = {
        listen: vi.fn(async (onCli: any) => {
          capturedOnCLI = onCli;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      deps = createMockDeps({
        server,
        adapter: adapter as any,
        launcher: launcher as any,
      });
      return { hub: new SessionTransportHub(deps), adapter };
    }

    it("buffers messages before deliverSocket and replays them", async () => {
      const { hub, adapter } = setupForBuffering();
      await hub.start();

      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      // Simulate messages arriving before deliverSocket completes
      // The "on" registered by handleCliConnection buffers into `buffered[]`
      // Find the 'message' handler registered during handleCliConnection
      const messageHandlerCall = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "message",
      );
      expect(messageHandlerCall).toBeDefined();
      const earlyMessageHandler = messageHandlerCall![1] as (data: unknown) => void;
      earlyMessageHandler("early-msg-1");
      earlyMessageHandler("early-msg-2");

      // Wait for deliverSocket
      await vi.waitFor(() => {
        expect(adapter.deliverSocket).toHaveBeenCalled();
      });

      // The socketForAdapter proxy was delivered — verify the adapter got the proxy
      const deliveredSocket = (deps.toAdapterSocket as ReturnType<typeof vi.fn>).mock.results[0]
        .value;
      expect(deliveredSocket).toBeDefined();
    });
  });

  // ── socketForAdapter proxy ─────────────────────────────────────────────

  describe("socketForAdapter proxy", () => {
    let capturedOnCLI: (socket: any, sessionId: string) => void;
    let toAdapterSocketCapture: any;

    async function setupProxy() {
      const adapter = makeInvertedAdapter(true);
      const launcher = {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      };
      const server = {
        listen: vi.fn(async (onCli: any) => {
          capturedOnCLI = onCli;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const toAdapterSocket = vi.fn((s: any) => {
        toAdapterSocketCapture = s;
        return s;
      });
      deps = createMockDeps({
        server,
        adapter: adapter as any,
        launcher: launcher as any,
        toAdapterSocket,
      });
      const hub = new SessionTransportHub(deps);
      await hub.start();
      return { hub, adapter };
    }

    it("send proxies to underlying socket", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      toAdapterSocketCapture.send("hello");
      expect(socket.send).toHaveBeenCalledWith("hello");
    });

    it("close proxies to underlying socket", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      toAdapterSocketCapture.close(1000, "done");
      expect(socket.close).toHaveBeenCalledWith(1000, "done");
    });

    it("bufferedAmount reads from underlying socket", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      expect(toAdapterSocketCapture.bufferedAmount).toBe(42);
    });

    it("on('message') forwards and replays buffered messages", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      // Push an early message before deliverSocket
      const earlyHandler = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "message",
      )![1] as (data: unknown) => void;
      earlyHandler("buffered-msg");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      // Register a message handler on the proxy
      const received: unknown[] = [];
      toAdapterSocketCapture.on("message", (data: unknown) => received.push(data));

      // Buffered message should have been replayed
      expect(received).toContain("buffered-msg");
    });

    it("on('close') forwards to underlying socket", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      const closeHandler = vi.fn();
      toAdapterSocketCapture.on("close", closeHandler);

      // Underlying socket.on should have been called with "close"
      const closeCall = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "close" && call[1] === closeHandler,
      );
      expect(closeCall).toBeDefined();
    });

    it("on('error') forwards to underlying socket", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      const errorHandler = vi.fn();
      toAdapterSocketCapture.on("error", errorHandler);

      const errorCall = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "error" && call[1] === errorHandler,
      );
      expect(errorCall).toBeDefined();
    });

    it("on() with unknown event is silently ignored", async () => {
      await setupProxy();
      const socket = createMockSocket();
      capturedOnCLI(socket, "sess-1");

      await vi.waitFor(() => {
        expect(toAdapterSocketCapture).toBeDefined();
      });

      // Should not throw
      toAdapterSocketCapture.on("unknown_event", vi.fn());

      // Unknown events should NOT be forwarded to underlying socket
      const unknownCall = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "unknown_event",
      );
      expect(unknownCall).toBeUndefined();
    });
  });

  // ── handleConsumerConnection ───────────────────────────────────────────

  describe("handleConsumerConnection", () => {
    it("wires message and close events to bridge", async () => {
      let capturedOnConsumer: (socket: any, context: any) => void;
      const server = {
        listen: vi.fn(async (_onCli: any, onConsumer: any) => {
          capturedOnConsumer = onConsumer;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      deps = createMockDeps({ server });
      const hub = new SessionTransportHub(deps);
      await hub.start();

      const socket = createMockSocket();
      const context = {
        sessionId: "cons-sess-1",
        userId: "u1",
        displayName: "User",
        role: "participant",
      };

      capturedOnConsumer!(socket, context);

      expect(deps.bridge.handleConsumerOpen).toHaveBeenCalledWith(socket, context);

      // Simulate message
      const messageHandler = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "message",
      )![1] as (data: unknown) => void;
      messageHandler("test-data");
      expect(deps.bridge.handleConsumerMessage).toHaveBeenCalledWith(
        socket,
        "cons-sess-1",
        "test-data",
      );

      // Simulate close
      const closeHandler = socket.on.mock.calls.find(
        (call: unknown[]) => call[0] === "close",
      )![1] as () => void;
      closeHandler();
      expect(deps.bridge.handleConsumerClose).toHaveBeenCalledWith(socket, "cons-sess-1");
    });
  });
});
