import type { BridgeEventMap, LauncherEventMap } from "../../types/events.js";

export type DomainBridgeEventType = Exclude<keyof BridgeEventMap, "message:inbound">;
export type DomainEventType = DomainBridgeEventType | keyof LauncherEventMap;
export type DomainEventSource = "bridge" | "launcher";

export type DomainEventPayload<T extends DomainEventType> = T extends keyof BridgeEventMap
  ? BridgeEventMap[T]
  : T extends keyof LauncherEventMap
    ? LauncherEventMap[T]
    : never;

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  source: DomainEventSource;
  type: DomainEventType;
  payload: DomainEventPayload<T>;
  timestamp: number;
}

export type DomainEventMap = {
  [K in DomainEventType]: DomainEvent<K>;
};
