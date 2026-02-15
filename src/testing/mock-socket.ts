import type { WebSocketLike } from "../interfaces/transport.js";

export interface MockSocket extends WebSocketLike {
  send: ReturnType<typeof createMockFn>;
  close: ReturnType<typeof createMockFn>;
  readonly sentMessages: string[];
}

// Simple mock function implementation (no vitest dependency for public API)
function createMockFn() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    if (fn._impl) return fn._impl(...args);
  };
  fn.calls = calls;
  fn.mockClear = () => {
    calls.length = 0;
  };
  fn.mockImplementation = (impl: (...args: unknown[]) => unknown) => {
    fn._impl = impl;
    return fn;
  };
  fn._impl = null as ((...args: unknown[]) => unknown) | null;
  return fn;
}

export function createMockSocket(): MockSocket {
  const sendFn = createMockFn();
  const closeFn = createMockFn();

  return {
    send: sendFn,
    close: closeFn,
    get sentMessages(): string[] {
      return sendFn.calls.map((c) => c[0] as string);
    },
  };
}
