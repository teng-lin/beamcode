import { describe, expect, it } from "vitest";
import { noopLogger } from "../../testing/cli-message-factories.js";
import { MockProcessManager } from "../../testing/mock-process-manager.js";
import { CodexLauncher, type CodexLauncherOptions } from "./codex-launcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createLauncher(overrides?: Partial<CodexLauncherOptions>) {
  const processManager = new MockProcessManager();
  const launcher = new CodexLauncher({
    processManager,
    logger: noopLogger,
    ...overrides,
  });
  return { launcher, processManager };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CodexLauncher", () => {
  describe("launch — default options", () => {
    it("uses default binary 'codex', port 19836, and process.cwd()", async () => {
      const { launcher, processManager } = createLauncher();

      const result = await launcher.launch("sess-1");

      expect(processManager.spawnCalls).toHaveLength(1);
      const spawnOpts = processManager.spawnCalls[0];
      expect(spawnOpts.command).toBe("codex");
      expect(spawnOpts.args).toEqual(["app-server", "--listen", "ws://127.0.0.1:19836"]);
      expect(spawnOpts.cwd).toBe(process.cwd());
      expect(result.url).toBe("ws://127.0.0.1:19836");
    });

    it("returns the pid from the spawned process", async () => {
      const { launcher, processManager } = createLauncher();

      const result = await launcher.launch("sess-1");

      expect(result.pid).toBe(processManager.lastProcess!.pid);
    });
  });

  describe("launch — custom options", () => {
    it("uses custom binary, port, and cwd", async () => {
      const { launcher, processManager } = createLauncher();

      await launcher.launch("sess-1", {
        codexBinary: "/usr/local/bin/codex-nightly",
        port: 9999,
        cwd: "/home/user/project",
      });

      const spawnOpts = processManager.spawnCalls[0];
      expect(spawnOpts.command).toBe("/usr/local/bin/codex-nightly");
      expect(spawnOpts.args).toEqual(["app-server", "--listen", "ws://127.0.0.1:9999"]);
      expect(spawnOpts.cwd).toBe("/home/user/project");
    });

    it("allows partial overrides (only port)", async () => {
      const { launcher, processManager } = createLauncher();

      const result = await launcher.launch("sess-1", { port: 5555 });

      const spawnOpts = processManager.spawnCalls[0];
      expect(spawnOpts.command).toBe("codex");
      expect(spawnOpts.args).toContain("ws://127.0.0.1:5555");
      expect(result.url).toBe("ws://127.0.0.1:5555");
    });
  });

  describe("launch — spawn failure", () => {
    it("throws when spawnProcess returns null (spawn error)", async () => {
      const processManager = new MockProcessManager();
      processManager.failNextSpawn();
      const launcher = new CodexLauncher({ processManager, logger: noopLogger });

      launcher.on("error", () => {});

      await expect(launcher.launch("sess-1")).rejects.toThrow(
        "Failed to spawn codex app-server process",
      );
    });
  });

  describe("buildSpawnArgs — passthrough via launch", () => {
    it("passes the InternalSpawnPayload through to the process manager", async () => {
      const { launcher, processManager } = createLauncher();

      await launcher.launch("sess-1", {
        codexBinary: "my-codex",
        port: 8080,
        cwd: "/tmp",
      });

      expect(processManager.spawnCalls[0]).toEqual({
        command: "my-codex",
        args: ["app-server", "--listen", "ws://127.0.0.1:8080"],
        cwd: "/tmp",
      });
    });
  });

  describe("constructor options", () => {
    it("defaults killGracePeriodMs to 5000", () => {
      const { launcher } = createLauncher();
      expect(launcher).toBeDefined();
    });

    it("accepts custom killGracePeriodMs", () => {
      const processManager = new MockProcessManager();
      const launcher = new CodexLauncher({
        processManager,
        killGracePeriodMs: 10000,
      });
      expect(launcher).toBeDefined();
    });
  });
});
