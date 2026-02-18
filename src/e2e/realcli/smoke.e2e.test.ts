import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessManager } from "../../adapters/node-process-manager.js";
import { getE2EProfile, isRealCliProfile } from "../helpers/e2e-profile.js";
import { createProcessManager } from "../helpers/test-utils.js";
import { getRealCliPrereqState } from "./prereqs.js";

const originalEnv = {
  E2E_PROFILE: process.env.E2E_PROFILE,
  USE_REAL_CLI: process.env.USE_REAL_CLI,
  USE_MOCK_CLI: process.env.USE_MOCK_CLI,
};

afterEach(() => {
  process.env.E2E_PROFILE = originalEnv.E2E_PROFILE;
  process.env.USE_REAL_CLI = originalEnv.USE_REAL_CLI;
  process.env.USE_MOCK_CLI = originalEnv.USE_MOCK_CLI;
});

describe("E2E Real CLI smoke foundation", () => {
  it("uses realcli profile under smoke mode", () => {
    process.env.E2E_PROFILE = "realcli-smoke";
    expect(getE2EProfile()).toBe("realcli-smoke");
    expect(isRealCliProfile()).toBe(true);
  });

  it("createProcessManager resolves to NodeProcessManager in realcli profile", () => {
    process.env.E2E_PROFILE = "realcli-smoke";
    process.env.USE_REAL_CLI = "true";
    delete process.env.USE_MOCK_CLI;

    const manager = createProcessManager();
    expect(manager).toBeInstanceOf(NodeProcessManager);
  });

  const prereqs = getRealCliPrereqState();

  it.runIf(prereqs.ok)("real cli preflight assumptions hold when this suite runs", () => {
    expect(getRealCliPrereqState().ok).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBeTruthy();
  });

  it.runIf(prereqs.ok)("NodeProcessManager can spawn claude --version", async () => {
    const manager = new NodeProcessManager();
    const proc = manager.spawn({
      command: "claude",
      args: ["--version"],
      cwd: process.cwd(),
      env: process.env,
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
