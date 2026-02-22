import type { Session } from "../session-repository.js";
import { SessionRuntime, type SessionRuntimeDeps } from "../session-runtime.js";
import { RuntimeManager } from "./runtime-manager.js";

export interface RuntimeManagerFactoryDeps {
  now: SessionRuntimeDeps["now"];
  maxMessageHistoryLength: SessionRuntimeDeps["maxMessageHistoryLength"];
  getBroadcaster: () => SessionRuntimeDeps["broadcaster"];
  getQueueHandler: () => SessionRuntimeDeps["queueHandler"];
  getSlashService: () => SessionRuntimeDeps["slashService"];
  sendToBackend: SessionRuntimeDeps["sendToBackend"];
  tracedNormalizeInbound: SessionRuntimeDeps["tracedNormalizeInbound"];
  persistSession: SessionRuntimeDeps["persistSession"];
  warnUnknownPermission: SessionRuntimeDeps["warnUnknownPermission"];
  emitPermissionResolved: SessionRuntimeDeps["emitPermissionResolved"];
  onSessionSeeded: SessionRuntimeDeps["onSessionSeeded"];
  onInvalidLifecycleTransition: SessionRuntimeDeps["onInvalidLifecycleTransition"];
  routeBackendMessage: SessionRuntimeDeps["routeBackendMessage"];
}

export function createRuntimeManager(deps: RuntimeManagerFactoryDeps): RuntimeManager {
  return new RuntimeManager(
    (session: Session) =>
      new SessionRuntime(session, {
        now: deps.now,
        maxMessageHistoryLength: deps.maxMessageHistoryLength,
        broadcaster: deps.getBroadcaster(),
        queueHandler: deps.getQueueHandler(),
        slashService: deps.getSlashService(),
        sendToBackend: deps.sendToBackend,
        tracedNormalizeInbound: deps.tracedNormalizeInbound,
        persistSession: deps.persistSession,
        warnUnknownPermission: deps.warnUnknownPermission,
        emitPermissionResolved: deps.emitPermissionResolved,
        onSessionSeeded: deps.onSessionSeeded,
        onInvalidLifecycleTransition: deps.onInvalidLifecycleTransition,
        routeBackendMessage: deps.routeBackendMessage,
      }),
  );
}
