import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessManager } from "../../adapters/node-process-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import { createProcessManager } from "../helpers/test-utils.js";
import { getRealCliPrereqState } from "./prereqs.js";

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

describe("E2E Real CLI process smoke matrix", () => {
  const prereqs = getRealCliPrereqState();
  const originalEnv = {
    E2E_PROFILE: process.env.E2E_PROFILE,
    USE_REAL_CLI: process.env.USE_REAL_CLI,
  };

  afterEach(() => {
    process.env.E2E_PROFILE = originalEnv.E2E_PROFILE;
    process.env.USE_REAL_CLI = originalEnv.USE_REAL_CLI;
  });

  it.runIf(prereqs.ok)("executes claude --version and exits 0", async () => {
    const pm = new NodeProcessManager();
    const proc = pm.spawn({
      command: "claude",
      args: ["--version"],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(await proc.exited).toBe(0);
  });

  it.runIf(prereqs.ok)("captures non-empty stdout from claude --version", async () => {
    const pm = new NodeProcessManager();
    const proc = pm.spawn({
      command: "claude",
      args: ["--version"],
      cwd: process.cwd(),
      env: process.env,
    });
    const [out, code] = await Promise.all([readStream(proc.stdout), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it.runIf(prereqs.ok)("executes claude --help and exits 0", async () => {
    const pm = new NodeProcessManager();
    const proc = pm.spawn({
      command: "claude",
      args: ["--help"],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(await proc.exited).toBe(0);
  });

  it.runIf(prereqs.ok)("captures help output containing usage text", async () => {
    const pm = new NodeProcessManager();
    const proc = pm.spawn({
      command: "claude",
      args: ["--help"],
      cwd: process.cwd(),
      env: process.env,
    });
    const [out, code] = await Promise.all([readStream(proc.stdout), proc.exited]);
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("usage");
  });

  it.runIf(prereqs.ok)("reports process liveness during execution", async () => {
    const pm = new NodeProcessManager();
    const proc = pm.spawn({
      command: "claude",
      args: ["--help"],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(typeof proc.pid).toBe("number");
    // May already have exited on fast machines; this should not throw either way.
    expect(typeof pm.isAlive(proc.pid)).toBe("boolean");
    await proc.exited;
  });

  it.runIf(prereqs.ok)("supports repeated sequential invocations", async () => {
    const pm = new NodeProcessManager();
    for (let i = 0; i < 3; i++) {
      const proc = pm.spawn({
        command: "claude",
        args: ["--version"],
        cwd: process.cwd(),
        env: process.env,
      });
      const code = await proc.exited;
      expect(code).toBe(0);
    }
  });

  it.runIf(prereqs.ok)("createProcessManager under real profile can execute claude", async () => {
    process.env.E2E_PROFILE = "real-smoke";
    process.env.USE_REAL_CLI = "true";
    const profile = getE2EProfile();
    expect(profile).toBe("real-smoke");

    const pm = createProcessManager();
    const proc = pm.spawn({
      command: "claude",
      args: ["--version"],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(await proc.exited).toBe(0);
  });
});
