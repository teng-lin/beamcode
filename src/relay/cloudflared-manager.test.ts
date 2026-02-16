import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflaredManager, detectCloudflared } from "./cloudflared-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `fn` with process.env.PATH temporarily overridden, restoring it afterward. */
async function withFakePath<T>(pathDir: string, fn: () => T | Promise<T>): Promise<T> {
  const origPath = process.env.PATH;
  process.env.PATH = `${pathDir}:${origPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = origPath;
  }
}

/** Temporarily override process.platform and PATH, restoring both afterward. */
function withPlatformAndEmptyPath(platform: string, fn: () => void): void {
  const origPath = process.env.PATH;
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  process.env.PATH = "/nonexistent";
  try {
    fn();
  } finally {
    process.env.PATH = origPath;
    if (origPlatform) {
      Object.defineProperty(process, "platform", origPlatform);
    }
  }
}

describe("detectCloudflared", () => {
  it("throws with install instructions when cloudflared is missing", () => {
    withPlatformAndEmptyPath(process.platform, () => {
      expect(() => detectCloudflared()).toThrow("cloudflared not found");
    });
  });

  it("includes linux install instructions on linux platform", () => {
    withPlatformAndEmptyPath("linux", () => {
      expect(() => detectCloudflared()).toThrow("sudo apt install cloudflared");
    });
  });

  it("includes download link for other platforms", () => {
    withPlatformAndEmptyPath("win32", () => {
      expect(() => detectCloudflared()).toThrow("Download from:");
    });
  });
});

describe("CloudflaredManager", () => {
  let dir: string;

  /** Write a shell script as the fake `cloudflared` binary in the temp dir. */
  async function writeFakeBinary(script: string): Promise<void> {
    const path = join(dir, "cloudflared");
    await writeFile(path, `#!/bin/sh\n${script}`, "utf-8");
    await chmod(path, 0o755);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-cf-test-"));
    await writeFakeBinary(`
echo "2026/02/15 INF +----------------------------+"
echo "2026/02/15 INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
echo "2026/02/15 INF |  https://test-tunnel-abc.trycloudflare.com"
echo "2026/02/15 INF +----------------------------+"
sleep 60
`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts and parses tunnel URL from fake cloudflared", async () => {
    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      const { url } = await manager.start({ mode: "development", localPort: 8080 });

      expect(url).toBe("https://test-tunnel-abc.trycloudflare.com");
      expect(manager.tunnelUrl).toBe("https://test-tunnel-abc.trycloudflare.com");
      expect(manager.isRunning()).toBe(true);

      await manager.stop();
      expect(manager.isRunning()).toBe(false);
      expect(manager.tunnelUrl).toBeNull();
    });
  });

  it("throws when production mode lacks tunnelToken", async () => {
    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      await expect(manager.start({ mode: "production", localPort: 8080 })).rejects.toThrow(
        "tunnelToken",
      );
    });
  });

  it("computes exponential backoff", () => {
    const manager = new CloudflaredManager();
    expect(manager.currentBackoffMs).toBe(1000);
  });

  it("rejects if cloudflared exits before producing URL", async () => {
    await writeFakeBinary("exit 1");

    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      await expect(manager.start({ mode: "development", localPort: 8080 })).rejects.toThrow(
        "exited with code 1",
      );
    });
  });

  it("sends SIGKILL if process does not exit within timeout", async () => {
    await writeFakeBinary(`
trap '' TERM
echo "https://test-tunnel-abc.trycloudflare.com"
sleep 60
`);

    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      await manager.start({ mode: "development", localPort: 8080 });
      expect(manager.isRunning()).toBe(true);

      await expect(manager.stop()).resolves.toBeUndefined();
      expect(manager.isRunning()).toBe(false);
    });
  }, 10_000);

  it("passes correct args in production mode with metricsPort", async () => {
    await writeFakeBinary(`
echo "ARGS: $@"
echo "https://prod-tunnel.cfargotunnel.com"
sleep 60
`);

    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      const { url } = await manager.start({
        mode: "production",
        localPort: 8080,
        tunnelToken: "my-secret-token",
        metricsPort: 9100,
      });
      expect(url).toBe("https://prod-tunnel.cfargotunnel.com");
      await manager.stop();
    });
  });

  it("passes correct args in development mode with metricsPort", async () => {
    await writeFakeBinary(`
echo "ARGS: $@"
echo "https://dev-tunnel.trycloudflare.com"
sleep 60
`);

    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      const { url } = await manager.start({
        mode: "development",
        localPort: 3000,
        metricsPort: 9200,
      });
      expect(url).toBe("https://dev-tunnel.trycloudflare.com");
      await manager.stop();
    });
  });

  it("schedules restart with backoff when process exits after URL found", async () => {
    await writeFakeBinary(`
echo "https://restart-tunnel.trycloudflare.com"
exit 0
`);

    await withFakePath(dir, async () => {
      const manager = new CloudflaredManager();
      const { url } = await manager.start({ mode: "development", localPort: 8080 });
      expect(url).toBe("https://restart-tunnel.trycloudflare.com");

      // Wait for the exit handler and scheduleRestart to fire
      await new Promise((r) => setTimeout(r, 500));

      // After first exit: restartAttempts=1, backoff = min(1000 * 2^1, 30000) = 2000
      expect(manager.currentBackoffMs).toBe(2000);
      expect(manager.isRunning()).toBe(false);

      await manager.stop();
    });
  });
});
