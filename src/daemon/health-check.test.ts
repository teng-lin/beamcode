import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHealthCheck } from "./health-check.js";
import type { DaemonState } from "./state-file.js";
import { readState, writeState } from "./state-file.js";

describe("health-check", () => {
  let dir: string;
  let statePath: string;
  let timer: NodeJS.Timeout | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-health-test-"));
    statePath = join(dir, "daemon.json");
  });

  afterEach(async () => {
    if (timer) clearInterval(timer);
    await rm(dir, { recursive: true, force: true });
  });

  it("updates heartbeat on interval", async () => {
    const state: DaemonState = {
      pid: process.pid,
      port: 0,
      heartbeat: 1000,
      version: "0.1.0",
      controlApiToken: "test",
    };
    await writeState(statePath, state);

    timer = startHealthCheck(statePath, 50);

    // Wait for at least one tick
    await new Promise((r) => setTimeout(r, 120));

    const updated = await readState(statePath);
    expect(updated).not.toBeNull();
    expect(updated!.heartbeat).toBeGreaterThan(1000);
  });
});
