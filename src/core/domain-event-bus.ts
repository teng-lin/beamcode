import type { BridgeEventMap, LauncherEventMap } from "../types/events.js";
import type {
  DomainBridgeEventType,
  DomainEvent,
  DomainEventMap,
  DomainEventPayload,
  DomainEventSource,
  DomainEventType,
} from "./interfaces/domain-events.js";
import { TypedEventEmitter } from "./typed-emitter.js";

export class DomainEventBus extends TypedEventEmitter<DomainEventMap> {
  constructor() {
    super();
    // Domain event names are derived from bridge/launcher event maps and include
    // the literal "error" key. In Node EventEmitter, emitting "error" without a
    // listener throws; the domain bus should never crash the coordinator path.
    this.on("error", () => {});
  }

  publish<T extends DomainEventType>(
    source: DomainEventSource,
    type: T,
    payload: DomainEventPayload<T>,
  ): void {
    const event: DomainEvent<T> = {
      source,
      type,
      payload,
      timestamp: Date.now(),
    };
    this.emit(type as keyof DomainEventMap & string, event as never);
  }

  publishBridge<T extends DomainBridgeEventType>(type: T, payload: BridgeEventMap[T]): void {
    this.publish("bridge", type as DomainEventType, payload as never);
  }

  publishLauncher<T extends keyof LauncherEventMap>(type: T, payload: LauncherEventMap[T]): void {
    this.publish("launcher", type as DomainEventType, payload as never);
  }
}
