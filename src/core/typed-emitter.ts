import { EventEmitter } from "node:events";

/**
 * Type-safe event emitter built on node:events.
 *
 * Usage:
 * ```ts
 * interface MyEvents {
 *   "foo": { bar: string };
 *   "error": { source: string; error: Error };
 * }
 * class MyClass extends TypedEventEmitter<MyEvents> {}
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: generic constraint must accept any event payload shape
export class TypedEventEmitter<TEvents extends Record<string, any>> {
  private emitter = new EventEmitter();

  constructor() {
    // Increase default max listeners since bridges may have many consumers
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof TEvents & string>(event: K, listener: (payload: TEvents[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof TEvents & string>(event: K, listener: (payload: TEvents[K]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof TEvents & string>(event: K, listener: (payload: TEvents[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof TEvents & string>(event?: K): this {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  protected emit<K extends keyof TEvents & string>(event: K, payload: TEvents[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}
