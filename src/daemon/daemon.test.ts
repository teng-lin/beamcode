import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "./daemon.js";
import { readState } from "./state-file.js";

describe("Daemon", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-daemon-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("start creates state file and reports port/token", async () => {
    const daemon = new Daemon();
    const result = await daemon.start({ dataDir: dir, port: 9999 });

    expect(result.port).toBe(9999);
    expect(result.controlApiToken).toHaveLength(64); // 32 bytes hex

    const state = await readState(join(dir, "daemon.json"));
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(process.pid);
    expect(state!.port).toBe(9999);
    expect(state!.controlApiToken).toBe(result.controlApiToken);

    expect(daemon.isRunning()).toBe(true);
    await daemon.stop();
  });

  it("stop releases lock and removes state file", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir: dir });
    await daemon.stop();

    expect(daemon.isRunning()).toBe(false);

    // Lock file should be gone
    await expect(stat(join(dir, "daemon.lock"))).rejects.toThrow();
    // State file should be gone
    const state = await readState(join(dir, "daemon.json"));
    expect(state).toBeNull();
  });

  it("double start throws", async () => {
    const d1 = new Daemon();
    const d2 = new Daemon();

    await d1.start({ dataDir: dir });

    await expect(d2.start({ dataDir: dir })).rejects.toThrow(/Daemon already running/);

    await d1.stop();
  });

  it("stop is idempotent", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir: dir });
    await daemon.stop();
    await daemon.stop(); // no throw
  });

  it("start releases lock if writeState throws", async () => {
    const daemon = new Daemon();

    // Mock writeState to throw after lock is acquired
    const stateFile = await import("./state-file.js");
    const writeSpy = vi
      .spyOn(stateFile, "writeState")
      .mockRejectedValueOnce(new Error("write failed"));

    try {
      await expect(daemon.start({ dataDir: dir })).rejects.toThrow("write failed");

      // Lock should be released — a second daemon should be able to start
      const d2 = new Daemon();
      const result = await d2.start({ dataDir: dir });
      expect(result.port).toBeDefined();
      await d2.stop();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("stop calls supervisor.stopAll() when supervisor is set", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir: dir });

    const mockSupervisor = { stopAll: vi.fn().mockResolvedValue(undefined) };
    daemon.setSupervisor(mockSupervisor);

    await daemon.stop();

    expect(mockSupervisor.stopAll).toHaveBeenCalledOnce();
    expect(daemon.isRunning()).toBe(false);
  });

  it("stop completes even when supervisor.stopAll() throws", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir: dir });

    const mockSupervisor = {
      stopAll: vi.fn().mockRejectedValue(new Error("supervisor crash")),
    };
    daemon.setSupervisor(mockSupervisor);

    // Suppress expected console.error
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await daemon.stop();

    expect(mockSupervisor.stopAll).toHaveBeenCalledOnce();
    expect(daemon.isRunning()).toBe(false);

    // Lock file should be gone even after supervisor error
    await expect(stat(join(dir, "daemon.lock"))).rejects.toThrow();

    errSpy.mockRestore();
  });

  it("stop handles already-deleted state file gracefully", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir: dir });

    // Manually delete the state file before stop
    await unlink(join(dir, "daemon.json"));

    // stop should not throw
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(daemon.isRunning()).toBe(false);
  });
});
