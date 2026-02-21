import { describe, expect, it, vi } from "vitest";
import { CliGateway } from "./cli-gateway.js";
import type { SessionTransportHubDeps } from "./interfaces/session-coordinator-coordination.js";

function createSocket() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    bufferedAmount: 0,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    }),
    _handlers: handlers,
  };
}

function createDeps(overrides?: Partial<SessionTransportHubDeps>): SessionTransportHubDeps {
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    server: null,
    port: 9414,
    toAdapterSocket: vi.fn((s) => s as any),
    ...overrides,
  };
}

describe("CliGateway", () => {
  it("rejects connection when session is not starting", () => {
    const deps = createDeps({
      launcher: {
        getSession: vi.fn().mockReturnValue({ state: "connected" }),
      } as any,
    });
    const gateway = new CliGateway(deps);
    const socket = createSocket();

    gateway.handleCliConnection(socket as any, "sess-1");

    expect(socket.close).toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rejecting unexpected"));
  });

  it("delivers socket via inverted adapter when backend connect succeeds", async () => {
    const adapter = {
      name: "claude",
      capabilities: {
        streaming: true,
        permissions: true,
        slashCommands: true,
        availability: "local",
        teams: false,
      },
      connect: vi.fn(),
      deliverSocket: vi.fn().mockReturnValue(true),
      cancelPending: vi.fn(),
    };
    const deps = createDeps({
      launcher: {
        getSession: vi.fn().mockReturnValue({ state: "starting" }),
      } as any,
      adapter: adapter as any,
    });
    const gateway = new CliGateway(deps);
    const socket = createSocket();

    gateway.handleCliConnection(socket as any, "sess-2");

    await vi.waitFor(() => {
      expect(adapter.deliverSocket).toHaveBeenCalled();
    });
    expect(deps.bridge.setAdapterName).toHaveBeenCalledWith("sess-2", "claude");
    expect(deps.bridge.connectBackend).toHaveBeenCalledWith("sess-2");
  });
});
