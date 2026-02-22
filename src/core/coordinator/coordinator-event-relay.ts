/**
 * CoordinatorEventRelay — pure wiring concern extracted from SessionCoordinator.
 *
 * Owns event registration, forwarding loops, and cleanup.
 * Domain listener bodies stay in SessionCoordinator and are injected
 * as named handler callbacks.
 *
 * @module SessionControl
 */

import type { BridgeEventMap, LauncherEventMap } from "../../types/events.js";
import type { DomainEventBus } from "../domain-event-bus.js";
import type { DomainEventMap } from "../interfaces/domain-events.js";

/**
 * Bridge events forwarded to domain bus + coordinator emitter.
 * Intentionally excludes team:* events (not currently wired).
 */
const BRIDGE_EVENTS = [
  "backend:connected",
  "backend:disconnected",
  "backend:session_id",
  "backend:relaunch_needed",
  "backend:message",
  "consumer:connected",
  "consumer:disconnected",
  "consumer:authenticated",
  "consumer:auth_failed",
  "message:outbound",
  "message:inbound",
  "permission:requested",
  "permission:resolved",
  "session:first_turn_completed",
  "session:closed",
  "slash_command:executed",
  "slash_command:failed",
  "capabilities:ready",
  "capabilities:timeout",
  "auth_status",
  "error",
] as const;

/** Launcher events forwarded to domain bus + coordinator emitter. */
const LAUNCHER_EVENTS = [
  "process:spawned",
  "process:exited",
  "process:connected",
  "process:resume_failed",
  "process:stdout",
  "process:stderr",
  "error",
] as const;

/** Minimal event source interface for bridge/launcher registration. */
interface EventSource {
  // biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
  on(event: string, handler: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
  off(event: string, handler: (...args: any[]) => void): unknown;
}

/** Handler callbacks injected by SessionCoordinator — domain logic stays in coordinator. */
export interface RelayHandlers {
  onProcessSpawned(payload: LauncherEventMap["process:spawned"]): void;
  onBackendSessionId(payload: BridgeEventMap["backend:session_id"]): void;
  onBackendConnected(payload: BridgeEventMap["backend:connected"]): void;
  onProcessResumeFailed(payload: LauncherEventMap["process:resume_failed"]): void;
  onProcessStdout(payload: LauncherEventMap["process:stdout"]): void;
  onProcessStderr(payload: LauncherEventMap["process:stderr"]): void;
  onProcessExited(payload: LauncherEventMap["process:exited"]): void;
  onFirstTurnCompleted(payload: BridgeEventMap["session:first_turn_completed"]): void;
  onSessionClosed(payload: BridgeEventMap["session:closed"]): void;
  onCapabilitiesTimeout(payload: BridgeEventMap["capabilities:timeout"]): void;
  onBackendRelaunchNeeded(payload: BridgeEventMap["backend:relaunch_needed"]): void;
}

export interface CoordinatorEventRelayDeps {
  emit: (event: string, payload: unknown) => void;
  domainEvents: DomainEventBus;
  bridge: EventSource;
  launcher: EventSource;
  handlers: RelayHandlers;
}

/**
 * Pure wiring relay: registers event listeners on bridge + launcher,
 * forwards to domain event bus and coordinator emitter, and routes
 * domain events to injected handler callbacks.
 */
export class CoordinatorEventRelay {
  private cleanups: (() => void)[] = [];
  private readonly deps: CoordinatorEventRelayDeps;

  constructor(deps: CoordinatorEventRelayDeps) {
    this.deps = deps;
  }

  /** Register all bridge/launcher event forwarders and domain listeners. */
  start(): void {
    const { emit, domainEvents, bridge, launcher, handlers } = this.deps;

    // Forward bridge events to domain bus + coordinator emitter.
    for (const event of BRIDGE_EVENTS) {
      // biome-ignore lint/suspicious/noExplicitAny: event forwarding — TypeScript cannot narrow dynamic event names
      const handler = (payload: any) => {
        // `message:inbound` is an input command, not a domain event.
        if (event !== "message:inbound") {
          // biome-ignore lint/suspicious/noExplicitAny: dynamic event name
          domainEvents.publishBridge(event as any, payload);
        }
        emit(event, payload);
      };
      bridge.on(event, handler);
      this.cleanups.push(() => bridge.off(event, handler));
    }

    // Forward launcher events to domain bus + coordinator emitter.
    for (const event of LAUNCHER_EVENTS) {
      // biome-ignore lint/suspicious/noExplicitAny: event forwarding — TypeScript cannot narrow dynamic event names
      const handler = (payload: any) => {
        domainEvents.publishLauncher(event, payload);
        emit(event, payload);
      };
      launcher.on(event, handler);
      this.cleanups.push(() => launcher.off(event, handler));
    }

    // Domain listeners → handler callbacks (domain logic stays in coordinator).
    this.trackDomain("process:spawned", ({ payload }) => handlers.onProcessSpawned(payload));
    this.trackDomain("backend:session_id", ({ payload }) => handlers.onBackendSessionId(payload));
    this.trackDomain("backend:connected", ({ payload }) => handlers.onBackendConnected(payload));
    this.trackDomain("process:resume_failed", ({ payload }) =>
      handlers.onProcessResumeFailed(payload),
    );
    this.trackDomain("process:stdout", ({ payload }) => handlers.onProcessStdout(payload));
    this.trackDomain("process:stderr", ({ payload }) => handlers.onProcessStderr(payload));
    this.trackDomain("process:exited", ({ payload }) => handlers.onProcessExited(payload));
    this.trackDomain("session:first_turn_completed", ({ payload }) =>
      handlers.onFirstTurnCompleted(payload),
    );
    this.trackDomain("session:closed", ({ payload }) => handlers.onSessionClosed(payload));
    this.trackDomain("capabilities:timeout", ({ payload }) =>
      handlers.onCapabilitiesTimeout(payload),
    );
    this.trackDomain("backend:relaunch_needed", ({ payload }) =>
      handlers.onBackendRelaunchNeeded(payload),
    );
  }

  /** Remove all registered listeners. */
  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }

  private trackDomain<K extends keyof DomainEventMap & string>(
    event: K,
    handler: (domainEvent: DomainEventMap[K]) => void,
  ): void {
    this.deps.domainEvents.on(event, handler);
    this.cleanups.push(() => this.deps.domainEvents.off(event, handler));
  }
}
