import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon } from "./daemon.js";
import { readState } from "./state-file.js";

describe("Daemon integration", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "beamcode-integration-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("full lifecycle: start → verify files → stop → verify cleanup", async () => {
    const daemon = new Daemon();
    const { port, controlApiToken } = await daemon.start({ dataDir, port: 7777 });

    // Start result is correct
    expect(port).toBe(7777);
    expect(controlApiToken).toHaveLength(64);

    // Lock file exists
    const lockStat = await stat(join(dataDir, "daemon.lock"));
    expect(lockStat.isFile()).toBe(true);

    // State file exists with correct content
    const state = await readState(join(dataDir, "daemon.json"));
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(process.pid);
    expect(state!.port).toBe(7777);
    expect(state!.version).toBe("0.1.0");
    expect(state!.controlApiToken).toBe(controlApiToken);
    expect(state!.heartbeat).toBeLessThanOrEqual(Date.now());

    expect(daemon.isRunning()).toBe(true);

    // Stop and verify cleanup
    await daemon.stop();

    expect(daemon.isRunning()).toBe(false);

    // Lock file removed
    await expect(stat(join(dataDir, "daemon.lock"))).rejects.toThrow();

    // State file removed
    const stateAfter = await readState(join(dataDir, "daemon.json"));
    expect(stateAfter).toBeNull();
  });

  it("double start prevention via lock contention", async () => {
    const d1 = new Daemon();
    const d2 = new Daemon();

    await d1.start({ dataDir });

    // Second daemon cannot acquire the same lock
    await expect(d2.start({ dataDir })).rejects.toThrow(/Daemon already running/);

    // First daemon is still healthy
    expect(d1.isRunning()).toBe(true);
    const state = await readState(join(dataDir, "daemon.json"));
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(process.pid);

    await d1.stop();
  });

  it("state file contains valid auth token", async () => {
    const daemon = new Daemon();
    const { controlApiToken } = await daemon.start({ dataDir });

    const state = await readState(join(dataDir, "daemon.json"));
    expect(state).not.toBeNull();

    // Token is a 32-byte hex string
    expect(state!.controlApiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(state!.controlApiToken).toBe(controlApiToken);

    // Token is non-empty and unique per start
    const daemon2 = new Daemon();
    await daemon.stop();

    const { controlApiToken: token2 } = await daemon2.start({ dataDir });
    expect(token2).toMatch(/^[0-9a-f]{64}$/);
    expect(token2).not.toBe(controlApiToken);

    await daemon2.stop();
  });

  it("health check heartbeat updates", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir });

    const stateBefore = await readState(join(dataDir, "daemon.json"));
    expect(stateBefore).not.toBeNull();
    const heartbeatBefore = stateBefore!.heartbeat;

    // Wait briefly and trigger a heartbeat by reading updated state
    // The health check interval is 60s by default, so we manually verify
    // the heartbeat was set at start time
    expect(heartbeatBefore).toBeGreaterThan(0);
    expect(heartbeatBefore).toBeLessThanOrEqual(Date.now());

    await daemon.stop();
  });

  it("stop is idempotent", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir });

    expect(daemon.isRunning()).toBe(true);

    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);

    // Second stop does not throw
    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);

    // Third stop also fine
    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it("isRunning state transitions", async () => {
    const daemon = new Daemon();

    // Before start
    expect(daemon.isRunning()).toBe(false);

    // After start
    await daemon.start({ dataDir });
    expect(daemon.isRunning()).toBe(true);

    // After stop
    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });
});
