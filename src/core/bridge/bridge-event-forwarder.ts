import type { RuntimeManager } from "./runtime-manager.js";

type LifecycleSignal = "backend:connected" | "backend:disconnected" | "session:closed";

function isLifecycleSignal(type: string): type is LifecycleSignal {
  return (
    type === "backend:connected" || type === "backend:disconnected" || type === "session:closed"
  );
}

/**
 * Forward a bridge event and mirror lifecycle signals into RuntimeManager.
 */
export function forwardBridgeEventWithLifecycle(
  runtimeManager: Pick<RuntimeManager, "handleLifecycleSignal">,
  emit: (type: string, payload: unknown) => void,
  type: string,
  payload: unknown,
): void {
  if (payload && typeof payload === "object" && "sessionId" in payload && isLifecycleSignal(type)) {
    const sessionId = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string") {
      runtimeManager.handleLifecycleSignal(sessionId, type);
    }
  }
  emit(type, payload);
}
