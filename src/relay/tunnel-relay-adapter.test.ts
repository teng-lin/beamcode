import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflaredManager, TunnelConfig } from "./cloudflared-manager.js";
import { TunnelRelayAdapter } from "./tunnel-relay-adapter.js";

function createMockManager(): CloudflaredManager {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
    tunnelUrl: null,
  };
}

describe("TunnelRelayAdapter", () => {
  const config: TunnelConfig = { mode: "development", localPort: 3000 };
  let manager: ReturnType<typeof createMockManager>;
  let adapter: TunnelRelayAdapter;

  beforeEach(() => {
    manager = createMockManager();
    adapter = new TunnelRelayAdapter({ manager, config });
  });

  it("tunnelUrl is null initially", () => {
    expect(adapter.tunnelUrl).toBeNull();
  });

  it("isRunning delegates to manager.isRunning()", () => {
    (manager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(adapter.isRunning).toBe(false);

    (manager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(adapter.isRunning).toBe(true);

    expect(manager.isRunning).toHaveBeenCalledTimes(2);
  });

  it("start() calls manager.start with config, returns url, and stores tunnelUrl", async () => {
    const expectedUrl = "https://test-tunnel.trycloudflare.com";
    (manager.start as ReturnType<typeof vi.fn>).mockResolvedValue({ url: expectedUrl });

    const result = await adapter.start();

    expect(manager.start).toHaveBeenCalledWith(config);
    expect(result).toBe(expectedUrl);
    expect(adapter.tunnelUrl).toBe(expectedUrl);
  });

  it("stop() calls manager.stop and clears tunnelUrl", async () => {
    const expectedUrl = "https://test-tunnel.trycloudflare.com";
    (manager.start as ReturnType<typeof vi.fn>).mockResolvedValue({ url: expectedUrl });

    await adapter.start();
    expect(adapter.tunnelUrl).toBe(expectedUrl);

    await adapter.stop();

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(adapter.tunnelUrl).toBeNull();
  });

  it("full lifecycle: start -> running -> stop -> not running", async () => {
    const expectedUrl = "https://lifecycle-test.trycloudflare.com";
    (manager.start as ReturnType<typeof vi.fn>).mockResolvedValue({ url: expectedUrl });
    (manager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Before start
    expect(adapter.tunnelUrl).toBeNull();
    expect(adapter.isRunning).toBe(false);

    // Start
    (manager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const url = await adapter.start();
    expect(url).toBe(expectedUrl);
    expect(adapter.tunnelUrl).toBe(expectedUrl);
    expect(adapter.isRunning).toBe(true);

    // Stop
    (manager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await adapter.stop();
    expect(adapter.tunnelUrl).toBeNull();
    expect(adapter.isRunning).toBe(false);
  });
});
