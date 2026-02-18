import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonState } from "./state-file.js";
import { readState, updateHeartbeat, writeState } from "./state-file.js";

describe("state-file", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-state-test-"));
    statePath = join(dir, "daemon.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sampleState: DaemonState = {
    pid: 12345,
    port: 8080,
    heartbeat: 1000,
    version: "0.1.0",
    controlApiToken: "abc123",
  };

  it("write/read roundtrip preserves data", async () => {
    await writeState(statePath, sampleState);
    const loaded = await readState(statePath);
    expect(loaded).toEqual(sampleState);
  });

  it("readState returns null for missing file", async () => {
    const result = await readState(join(dir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  it("updateHeartbeat changes the heartbeat timestamp", async () => {
    await writeState(statePath, sampleState);

    // Small delay to ensure Date.now() is different
    await new Promise((r) => setTimeout(r, 10));
    await updateHeartbeat(statePath);

    const updated = await readState(statePath);
    expect(updated).not.toBeNull();
    expect(updated!.heartbeat).toBeGreaterThan(sampleState.heartbeat);
    // Other fields unchanged
    expect(updated!.pid).toBe(sampleState.pid);
    expect(updated!.port).toBe(sampleState.port);
  });

  it("writeState cleans up tmp file and re-throws when rename fails", async () => {
    // Make statePath a directory so rename(tmpPath, statePath) fails with EISDIR
    await mkdir(statePath);

    await expect(writeState(statePath, sampleState)).rejects.toThrow();

    // The tmp file should have been cleaned up
    const tmpPath = `${statePath}.tmp`;
    await expect(stat(tmpPath)).rejects.toThrow();
  });

  it("updateHeartbeat is a no-op when state file does not exist", async () => {
    const missingPath = join(dir, "nonexistent-state.json");

    // Should not throw
    await expect(updateHeartbeat(missingPath)).resolves.toBeUndefined();

    // No file should have been created
    await expect(stat(missingPath)).rejects.toThrow();
  });
});
