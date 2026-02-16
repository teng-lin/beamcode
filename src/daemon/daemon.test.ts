import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
