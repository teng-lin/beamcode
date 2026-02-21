import { describe, expect, it, vi } from "vitest";
import type { ConsumerGatewayDeps } from "./consumer-gateway.js";
import { ConsumerGateway } from "./consumer-gateway.js";

function createDeps(overrides?: Partial<ConsumerGatewayDeps>): ConsumerGatewayDeps {
  return {
    sessions: {
      get: vi.fn(() => undefined),
    },
    gatekeeper: {
      hasAuthenticator: vi.fn(() => false),
      authenticateAsync: vi.fn(async () => null),
      createAnonymousIdentity: vi.fn(() => ({
        userId: "u1",
        displayName: "User",
        role: "participant",
      })),
      cancelPendingAuth: vi.fn(),
      authorize: vi.fn(() => true),
      createRateLimiter: vi.fn(() => undefined),
    },
    broadcaster: {
      sendTo: vi.fn(),
      broadcastPresence: vi.fn(),
    },
    gitTracker: {
      resolveGitInfo: vi.fn(),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    emit: vi.fn(),
    allocateAnonymousIdentityIndex: vi.fn(() => 1),
    checkRateLimit: vi.fn(() => true),
    getConsumerIdentity: vi.fn(() => undefined),
    getConsumerCount: vi.fn(() => 0),
    getState: vi.fn(),
    getMessageHistory: vi.fn(() => []),
    getPendingPermissions: vi.fn(() => []),
    getQueuedMessage: vi.fn(() => null),
    isBackendConnected: vi.fn(() => false),
    registerConsumer: vi.fn(),
    unregisterConsumer: vi.fn(),
    routeConsumerMessage: vi.fn(),
    maxConsumerMessageSize: 256 * 1024,
    tracer: {
      recv: vi.fn(),
      send: vi.fn(),
      translate: vi.fn(),
      error: vi.fn(),
    } as any,
    ...overrides,
  };
}

describe("ConsumerGateway", () => {
  it("exposes transport entry points", () => {
    const deps = createDeps();
    const gateway = new ConsumerGateway(deps);
    const ws = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 } as any;

    expect(() => gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any)).not.toThrow();
    expect(() =>
      gateway.handleConsumerMessage(ws, "s1", JSON.stringify({ type: "interrupt" })),
    ).not.toThrow();
    expect(() => gateway.handleConsumerClose(ws, "s1")).not.toThrow();
  });
});
