import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudflaredManager, detectCloudflared } from "./cloudflared-manager.js";

describe("detectCloudflared", () => {
  it("throws with install instructions when cloudflared is missing", () => {
    // Use a fake PATH that doesn't contain cloudflared
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(() => detectCloudflared()).toThrow("cloudflared not found");
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("CloudflaredManager", () => {
  let dir: string;
  let fakeBinary: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-cf-test-"));
    // Create a fake cloudflared script that prints a tunnel URL then exits
    fakeBinary = join(dir, "cloudflared");
    await writeFile(
      fakeBinary,
      `#!/bin/sh
echo "2026/02/15 INF +----------------------------+"
echo "2026/02/15 INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
echo "2026/02/15 INF |  https://test-tunnel-abc.trycloudflare.com"
echo "2026/02/15 INF +----------------------------+"
# Keep running until killed
sleep 60
`,
      "utf-8",
    );
    await chmod(fakeBinary, 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts and parses tunnel URL from fake cloudflared", async () => {
    const manager = new CloudflaredManager();

    // Override PATH to include our fake binary
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath}`;

    try {
      const { url } = await manager.start({
        mode: "development",
        localPort: 8080,
      });
      expect(url).toBe("https://test-tunnel-abc.trycloudflare.com");
      expect(manager.tunnelUrl).toBe("https://test-tunnel-abc.trycloudflare.com");
      expect(manager.isRunning()).toBe(true);

      await manager.stop();
      expect(manager.isRunning()).toBe(false);
      expect(manager.tunnelUrl).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("throws when production mode lacks tunnelToken", async () => {
    const manager = new CloudflaredManager();
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath}`;

    try {
      await expect(manager.start({ mode: "production", localPort: 8080 })).rejects.toThrow(
        "tunnelToken",
      );
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("computes exponential backoff", () => {
    const manager = new CloudflaredManager();

    // Access internal backoff computation via the exposed getter
    // restartAttempts = 0 → 1s
    expect(manager.currentBackoffMs).toBe(1000);
  });

  it("rejects if cloudflared exits before producing URL", async () => {
    // Create a fake cloudflared that exits immediately without URL
    const failBinary = join(dir, "cloudflared");
    await writeFile(failBinary, "#!/bin/sh\nexit 1\n", "utf-8");
    await chmod(failBinary, 0o755);

    const manager = new CloudflaredManager();
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath}`;

    try {
      await expect(manager.start({ mode: "development", localPort: 8080 })).rejects.toThrow(
        "exited with code 1",
      );
    } finally {
      process.env.PATH = origPath;
    }
  });
});
