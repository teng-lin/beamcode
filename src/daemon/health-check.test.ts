import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noopLogger } from "../adapters/noop-logger.js";
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
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

    timer = startHealthCheck(statePath, noopLogger, 50);

    // Poll until heartbeat updates (tolerates slow CI runners)
    let updated: DaemonState | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      updated = await readState(statePath);
      if (updated && updated.heartbeat > 1000) break;
    }
    expect(updated).not.toBeNull();
    expect(updated!.heartbeat).toBeGreaterThan(1000);
  });
});
