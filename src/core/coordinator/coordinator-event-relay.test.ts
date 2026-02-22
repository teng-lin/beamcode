import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DomainEventBus } from "../domain-event-bus.js";
import { CoordinatorEventRelay, type RelayHandlers } from "./coordinator-event-relay.js";

function createMockSource(): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return emitter;
}

function createMockHandlers(): RelayHandlers {
  return {
    onProcessSpawned: vi.fn(),
    onBackendSessionId: vi.fn(),
    onBackendConnected: vi.fn(),
    onProcessResumeFailed: vi.fn(),
    onProcessStdout: vi.fn(),
    onProcessStderr: vi.fn(),
    onProcessExited: vi.fn(),
    onFirstTurnCompleted: vi.fn(),
    onSessionClosed: vi.fn(),
    onCapabilitiesTimeout: vi.fn(),
    onBackendRelaunchNeeded: vi.fn(),
  };
}

function createRelay(overrides?: {
  bridge?: EventEmitter;
  launcher?: EventEmitter;
  handlers?: RelayHandlers;
  domainEvents?: DomainEventBus;
  emit?: (event: string, payload: unknown) => void;
}) {
  const bridge = overrides?.bridge ?? createMockSource();
  const launcher = overrides?.launcher ?? createMockSource();
  const handlers = overrides?.handlers ?? createMockHandlers();
  const domainEvents = overrides?.domainEvents ?? new DomainEventBus();
  const emit = overrides?.emit ?? vi.fn();

  const relay = new CoordinatorEventRelay({
    emit,
    domainEvents,
    bridge,
    launcher,
    handlers,
  });

  return { relay, bridge, launcher, handlers, domainEvents, emit };
}

describe("CoordinatorEventRelay", () => {
  // -----------------------------------------------------------------------
  // Event list snapshots
  // -----------------------------------------------------------------------

  describe("event list snapshots", () => {
    it("registers the expected bridge events", () => {
      const bridge = createMockSource();
      const events: string[] = [];
      const origOn = bridge.on.bind(bridge);
      vi.spyOn(bridge, "on").mockImplementation((event: string, handler: any) => {
        events.push(event);
        return origOn(event, handler);
      });

      const { relay } = createRelay({ bridge });
      relay.start();

      expect(events.sort()).toMatchInlineSnapshot(`
        [
          "auth_status",
          "backend:connected",
          "backend:disconnected",
          "backend:message",
          "backend:relaunch_needed",
          "backend:session_id",
          "capabilities:ready",
          "capabilities:timeout",
          "consumer:auth_failed",
          "consumer:authenticated",
          "consumer:connected",
          "consumer:disconnected",
          "error",
          "message:inbound",
          "message:outbound",
          "permission:requested",
          "permission:resolved",
          "session:closed",
          "session:first_turn_completed",
          "slash_command:executed",
          "slash_command:failed",
        ]
      `);
    });

    it("registers the expected launcher events", () => {
      const launcher = createMockSource();
      const events: string[] = [];
      const origOn = launcher.on.bind(launcher);
      vi.spyOn(launcher, "on").mockImplementation((event: string, handler: any) => {
        events.push(event);
        return origOn(event, handler);
      });

      const { relay } = createRelay({ launcher });
      relay.start();

      expect(events.sort()).toMatchInlineSnapshot(`
        [
          "error",
          "process:connected",
          "process:exited",
          "process:resume_failed",
          "process:spawned",
          "process:stderr",
          "process:stdout",
        ]
      `);
    });
  });

  // -----------------------------------------------------------------------
  // message:inbound exclusion
  // -----------------------------------------------------------------------

  describe("message:inbound exclusion", () => {
    it("does NOT publish message:inbound to domainEvents", () => {
      const { relay, bridge, domainEvents, emit } = createRelay();
      const publishSpy = vi.spyOn(domainEvents, "publishBridge");
      relay.start();

      bridge.emit("message:inbound", { sessionId: "s1", message: {} });

      expect(publishSpy).not.toHaveBeenCalled();
      // But it should still be forwarded via emit
      expect(emit).toHaveBeenCalledWith("message:inbound", { sessionId: "s1", message: {} });
    });
  });

  // -----------------------------------------------------------------------
  // Forwarding behavior
  // -----------------------------------------------------------------------

  describe("forwarding", () => {
    it("forwards bridge events via emit and domainEvents.publishBridge", () => {
      const { relay, bridge, domainEvents, emit } = createRelay();
      const publishSpy = vi.spyOn(domainEvents, "publishBridge");
      relay.start();

      const payload = { sessionId: "s1" };
      bridge.emit("backend:connected", payload);

      expect(emit).toHaveBeenCalledWith("backend:connected", payload);
      expect(publishSpy).toHaveBeenCalledWith("backend:connected", payload);
    });

    it("forwards launcher events via emit and domainEvents.publishLauncher", () => {
      const { relay, launcher, domainEvents, emit } = createRelay();
      const publishSpy = vi.spyOn(domainEvents, "publishLauncher");
      relay.start();

      const payload = { sessionId: "s1", pid: 1234 };
      launcher.emit("process:spawned", payload);

      expect(emit).toHaveBeenCalledWith("process:spawned", payload);
      expect(publishSpy).toHaveBeenCalledWith("process:spawned", payload);
    });
  });

  // -----------------------------------------------------------------------
  // stop() cleanup
  // -----------------------------------------------------------------------

  describe("stop()", () => {
    it("removes all listeners — events no longer forwarded after stop", () => {
      const { relay, bridge, launcher, emit } = createRelay();
      relay.start();

      bridge.emit("backend:connected", { sessionId: "s1" });
      expect(emit).toHaveBeenCalledTimes(1);

      relay.stop();
      (emit as ReturnType<typeof vi.fn>).mockClear();

      bridge.emit("backend:connected", { sessionId: "s1" });
      launcher.emit("process:spawned", { sessionId: "s1", pid: 1 });
      expect(emit).not.toHaveBeenCalled();
    });

    it("removes domain listeners — handlers no longer called after stop", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("backend:connected", { sessionId: "s1" });
      expect(handlers.onBackendConnected).toHaveBeenCalledTimes(1);

      relay.stop();
      domainEvents.publishBridge("backend:connected", { sessionId: "s2" });
      expect(handlers.onBackendConnected).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // -----------------------------------------------------------------------
  // Handler callback routing (via domain events)
  // -----------------------------------------------------------------------

  describe("handler callback routing", () => {
    it("onProcessSpawned called for process:spawned", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishLauncher("process:spawned", { sessionId: "s1", pid: 42 });
      expect(handlers.onProcessSpawned).toHaveBeenCalledWith({ sessionId: "s1", pid: 42 });
    });

    it("onBackendSessionId called for backend:session_id", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("backend:session_id", {
        sessionId: "s1",
        backendSessionId: "cli-123",
      });
      expect(handlers.onBackendSessionId).toHaveBeenCalledWith({
        sessionId: "s1",
        backendSessionId: "cli-123",
      });
    });

    it("onBackendConnected called for backend:connected", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("backend:connected", { sessionId: "s1" });
      expect(handlers.onBackendConnected).toHaveBeenCalledWith({ sessionId: "s1" });
    });

    it("onProcessResumeFailed called for process:resume_failed", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishLauncher("process:resume_failed", { sessionId: "s1" });
      expect(handlers.onProcessResumeFailed).toHaveBeenCalledWith({ sessionId: "s1" });
    });

    it("onProcessStdout called for process:stdout", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishLauncher("process:stdout", { sessionId: "s1", data: "hello" });
      expect(handlers.onProcessStdout).toHaveBeenCalledWith({ sessionId: "s1", data: "hello" });
    });

    it("onProcessStderr called for process:stderr", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishLauncher("process:stderr", { sessionId: "s1", data: "err" });
      expect(handlers.onProcessStderr).toHaveBeenCalledWith({ sessionId: "s1", data: "err" });
    });

    it("onProcessExited called for process:exited", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishLauncher("process:exited", {
        sessionId: "s1",
        exitCode: 1,
        uptimeMs: 5000,
      });
      expect(handlers.onProcessExited).toHaveBeenCalledWith({
        sessionId: "s1",
        exitCode: 1,
        uptimeMs: 5000,
      });
    });

    it("onFirstTurnCompleted called for session:first_turn_completed", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("session:first_turn_completed", {
        sessionId: "s1",
        firstUserMessage: "hello",
      });
      expect(handlers.onFirstTurnCompleted).toHaveBeenCalledWith({
        sessionId: "s1",
        firstUserMessage: "hello",
      });
    });

    it("onSessionClosed called for session:closed", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("session:closed", { sessionId: "s1" });
      expect(handlers.onSessionClosed).toHaveBeenCalledWith({ sessionId: "s1" });
    });

    it("onCapabilitiesTimeout called for capabilities:timeout", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("capabilities:timeout", { sessionId: "s1" });
      expect(handlers.onCapabilitiesTimeout).toHaveBeenCalledWith({ sessionId: "s1" });
    });

    it("onBackendRelaunchNeeded called for backend:relaunch_needed", () => {
      const { relay, domainEvents, handlers } = createRelay();
      relay.start();

      domainEvents.publishBridge("backend:relaunch_needed", { sessionId: "s1" });
      expect(handlers.onBackendRelaunchNeeded).toHaveBeenCalledWith({ sessionId: "s1" });
    });
  });

  // -----------------------------------------------------------------------
  // Full chain: bridge/launcher event → forwarding → domain bus → handler
  // -----------------------------------------------------------------------

  describe("full chain integration", () => {
    it("bridge event flows through to domain handler callback", () => {
      const { relay, bridge, handlers } = createRelay();
      relay.start();

      bridge.emit("backend:connected", { sessionId: "s1" });
      expect(handlers.onBackendConnected).toHaveBeenCalledWith({ sessionId: "s1" });
    });

    it("launcher event flows through to domain handler callback", () => {
      const { relay, launcher, handlers } = createRelay();
      relay.start();

      launcher.emit("process:spawned", { sessionId: "s1", pid: 42 });
      expect(handlers.onProcessSpawned).toHaveBeenCalledWith({ sessionId: "s1", pid: 42 });
    });
  });
});
