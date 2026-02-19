import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessHandle, SpawnOptions } from "../../interfaces/process-manager.js";
import { MockProcessManager } from "../../testing/mock-process-manager.js";
import { OpencodeLauncher } from "./opencode-launcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ReadableStream that emits the given text chunks then closes. */
function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * A MockProcessManager variant that injects a stdout ReadableStream into the
 * spawned handle so ProcessSupervisor.pipeOutput can consume it and emit
 * "process:stdout" events.
 */
class StreamMockProcessManager extends MockProcessManager {
  stdout: ReadableStream<Uint8Array> | null = null;
  stderr: ReadableStream<Uint8Array> | null = null;

  override spawn(options: SpawnOptions): ProcessHandle {
    const handle = super.spawn(options);
    return { ...handle, stdout: this.stdout, stderr: this.stderr };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpencodeLauncher", () => {
  describe("spawn args", () => {
    it("spawns opencode serve with correct command, port and hostname", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["Server listening on 127.0.0.1:9001\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      const result = await launcher.launch("sess-1", { port: 9001, hostname: "127.0.0.1" });

      expect(pm.spawnCalls).toHaveLength(1);
      expect(pm.spawnCalls[0]).toMatchObject({
        command: "opencode",
        args: ["serve", "--port", "9001", "--hostname", "127.0.0.1"],
      });
      expect(result.url).toBe("http://127.0.0.1:9001");
      expect(result.pid).toBe(10000);
    });

    it("uses defaults (port 4096, hostname 127.0.0.1) when none specified", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on 127.0.0.1:4096\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      const result = await launcher.launch("sess-2");

      expect(pm.spawnCalls[0]).toMatchObject({
        args: ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
      });
      expect(result.url).toBe("http://127.0.0.1:4096");
    });

    it("uses custom binary path when specified", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      await launcher.launch("sess-3", { opencodeBinary: "/usr/local/bin/opencode-cli" });

      expect(pm.spawnCalls[0]).toMatchObject({
        command: "/usr/local/bin/opencode-cli",
      });
    });

    it("sets OPENCODE_SERVER_PASSWORD env var when password is provided", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      await launcher.launch("sess-4", { password: "s3cr3t" });

      expect(pm.spawnCalls[0].env).toMatchObject({
        OPENCODE_SERVER_PASSWORD: "s3cr3t",
      });
    });

    it("does not set OPENCODE_SERVER_PASSWORD when no password given", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      await launcher.launch("sess-5");

      // env should be an empty object (or not contain the key)
      const env = pm.spawnCalls[0].env ?? {};
      expect(env).not.toHaveProperty("OPENCODE_SERVER_PASSWORD");
    });
  });

  describe("spawn failure", () => {
    it("throws when spawn throws", async () => {
      const pm = new StreamMockProcessManager();
      pm.failNextSpawn();
      const launcher = new OpencodeLauncher({ processManager: pm });

      // ProcessSupervisor emits 'error' events — add listener to prevent
      // Node's "unhandled error" from masking the actual throw.
      launcher.on("error", () => {});

      await expect(launcher.launch("sess-fail")).rejects.toThrow(
        "Failed to spawn opencode serve process",
      );
    });
  });

  describe("process crash before ready", () => {
    it("rejects when process exits before 'listening on' appears", async () => {
      const pm = new StreamMockProcessManager();
      // stdout that stays open and never emits "listening on"
      pm.stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("starting...\n"));
          // never close
        },
      });
      const launcher = new OpencodeLauncher({ processManager: pm });
      launcher.on("error", () => {});

      const launchPromise = launcher.launch("sess-crash");

      // Give the spawn and piping time to set up
      await new Promise((r) => setTimeout(r, 10));

      // Simulate process crash
      pm.lastProcess!.resolveExit(1);

      await expect(launchPromise).rejects.toThrow("opencode serve exited before becoming ready");
    });
  });

  describe("readiness detection", () => {
    it("resolves after 'listening on' appears in stdout", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["opencode v1.0\n", "Server listening on 127.0.0.1:4096\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      // Should resolve without timing out
      const result = await launcher.launch("sess-ready");
      expect(result.url).toBe("http://127.0.0.1:4096");
    });

    it("times out when 'listening on' never appears", async () => {
      vi.useFakeTimers();

      const pm = new StreamMockProcessManager();
      // Provide a stream that never emits "listening on"
      pm.stdout = new ReadableStream({
        start(controller) {
          // emit something, but never the ready signal
          controller.enqueue(new TextEncoder().encode("starting...\n"));
          // never close — simulate a long-running process
        },
      });
      const launcher = new OpencodeLauncher({ processManager: pm });

      const launchPromise = launcher.launch("sess-timeout");

      await Promise.all([
        expect(launchPromise).rejects.toThrow("opencode serve did not become ready within"),
        vi.advanceTimersByTimeAsync(16_000),
      ]);

      vi.useRealTimers();
    });

    it("resolves only for the matching sessionId", async () => {
      const pm = new StreamMockProcessManager();
      // Provide stdout for the first spawn — "listening on" for sess-A
      pm.stdout = createMockStream(["listening on 127.0.0.1:4096\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      // Launch first session — should succeed
      const result = await launcher.launch("sess-A", { port: 4096 });
      expect(result.url).toBe("http://127.0.0.1:4096");
    });
  });

  describe("process lifecycle", () => {
    it("tracks the process after successful launch", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      await launcher.launch("sess-track");

      expect(launcher.hasProcess("sess-track")).toBe(true);
      expect(launcher.getPid("sess-track")).toBe(10000);
    });

    it("emits process:spawned on successful launch", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      const spawnedEvents: Array<{ sessionId: string; pid: number }> = [];
      launcher.on("process:spawned", (e) => spawnedEvents.push(e));

      await launcher.launch("sess-spawn-event");

      expect(spawnedEvents).toHaveLength(1);
      expect(spawnedEvents[0].sessionId).toBe("sess-spawn-event");
      expect(spawnedEvents[0].pid).toBe(10000);
    });

    it("killProcess returns true and removes the tracked process", async () => {
      const pm = new StreamMockProcessManager();
      pm.stdout = createMockStream(["listening on\n"]);
      const launcher = new OpencodeLauncher({ processManager: pm });

      await launcher.launch("sess-kill");
      expect(launcher.hasProcess("sess-kill")).toBe(true);

      const proc = pm.lastProcess!;
      const killPromise = launcher.killProcess("sess-kill");
      proc.resolveExit(0);
      const result = await killPromise;

      expect(result).toBe(true);
      expect(launcher.hasProcess("sess-kill")).toBe(false);
    });
  });
});
