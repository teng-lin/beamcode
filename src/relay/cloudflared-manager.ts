import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";

export interface TunnelConfig {
  mode: "development" | "production";
  localPort: number;
  /** Required for production mode. Cloudflare tunnel token. */
  tunnelToken?: string;
  metricsPort?: number;
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

/**
 * URL pattern emitted by cloudflared to stdout when a tunnel is established.
 * Matches both trycloudflare.com (dev) and custom domains (prod).
 */
const TUNNEL_URL_PATTERN = /https:\/\/[a-zA-Z0-9._-]+\.(trycloudflare\.com|cfargotunnel\.com)\S*/;
const ANY_HTTPS_URL_PATTERN = /https:\/\/\S+/;

/**
 * Manages a cloudflared sidecar process.
 * Supports development mode (free ephemeral via trycloudflare.com)
 * and production mode (requires Cloudflare account + tunnel token).
 */
export class CloudflaredManager {
  private process: ChildProcess | null = null;
  private _tunnelUrl: string | null = null;
  private _running = false;
  private config: TunnelConfig | null = null;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private processCleanups: (() => void)[] = [];

  /** Resolve for the initial URL promise. */
  private urlResolve: ((url: string) => void) | null = null;
  private urlReject: ((err: Error) => void) | null = null;

  get tunnelUrl(): string | null {
    return this._tunnelUrl;
  }

  isRunning(): boolean {
    return this._running;
  }

  /**
   * Start cloudflared and wait for the tunnel URL.
   * Throws if cloudflared is not found or fails to start.
   */
  async start(config: TunnelConfig): Promise<{ url: string }> {
    detectCloudflared();

    this.config = config;
    this.stopped = false;
    this.restartAttempts = 0;

    if (config.mode === "production" && !config.tunnelToken) {
      throw new Error("Production mode requires a tunnelToken");
    }

    const url = await this.spawnAndWaitForUrl();
    return { url };
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Clean up process event listeners
    for (const cleanup of this.processCleanups) cleanup();
    this.processCleanups = [];

    if (this.process) {
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process?.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.process = null;
    }

    this._running = false;
    this._tunnelUrl = null;
  }

  private spawnAndWaitForUrl(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.urlResolve = resolve;
      this.urlReject = reject;
      this.spawnProcess();
    });
  }

  private spawnProcess(): void {
    if (!this.config) throw new Error("start() must be called before spawnProcess()");

    // Clean up old process listeners from previous spawn
    for (const cleanup of this.processCleanups) cleanup();
    this.processCleanups = [];

    const config = this.config;
    const { args, env } = this.buildArgs(config);

    const proc = spawn("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    this.process = proc;
    this._running = true;

    let urlFound = false;

    const handleData = (data: Buffer) => {
      const line = data.toString("utf-8");
      if (urlFound) return;

      const match = line.match(TUNNEL_URL_PATTERN) ?? line.match(ANY_HTTPS_URL_PATTERN);
      if (match) {
        urlFound = true;
        this._tunnelUrl = match[0];
        this.restartAttempts = 0;
        this.urlResolve?.(this._tunnelUrl);
        this.urlResolve = null;
        this.urlReject = null;
      }
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);
    this.processCleanups.push(() => {
      proc.stdout?.off("data", handleData);
      proc.stderr?.off("data", handleData);
    });

    const onError = (err: Error) => {
      this._running = false;
      if (!urlFound) {
        this.urlReject?.(err);
        this.urlResolve = null;
        this.urlReject = null;
      }
    };

    const onExit = (code: number | null) => {
      this._running = false;
      this.process = null;

      if (!urlFound) {
        this.urlReject?.(new Error(`cloudflared exited with code ${code} before producing a URL`));
        this.urlResolve = null;
        this.urlReject = null;
        return;
      }

      if (!this.stopped) {
        this.scheduleRestart();
      }
    };

    proc.on("error", onError);
    proc.on("exit", onExit);
    this.processCleanups.push(() => {
      proc.off("error", onError);
      proc.off("exit", onExit);
    });
  }

  private buildArgs(config: TunnelConfig): { args: string[]; env: NodeJS.ProcessEnv } {
    if (config.mode === "production" && config.tunnelToken) {
      // Pass token via env var to avoid leaking it in /proc/<pid>/cmdline
      const args = ["tunnel", "run"];
      if (config.metricsPort) {
        args.push("--metrics", `127.0.0.1:${config.metricsPort}`);
      }
      return { args, env: { ...process.env, TUNNEL_TOKEN: config.tunnelToken } };
    }

    // Development mode: quick tunnel via trycloudflare.com
    const args = ["tunnel", "--url", `http://localhost:${config.localPort}`];
    if (config.metricsPort) {
      args.push("--metrics", `127.0.0.1:${config.metricsPort}`);
    }
    return { args, env: process.env };
  }

  private scheduleRestart(): void {
    const backoffMs = Math.min(INITIAL_BACKOFF_MS * 2 ** this.restartAttempts, MAX_BACKOFF_MS);
    this.restartAttempts++;

    this.restartTimer = setTimeout(() => {
      if (this.stopped) return;
      this.spawnProcess();
    }, backoffMs);
  }

  /** Exposed for testing: current backoff value in ms. */
  get currentBackoffMs(): number {
    return Math.min(INITIAL_BACKOFF_MS * 2 ** this.restartAttempts, MAX_BACKOFF_MS);
  }
}

/**
 * Check if `cloudflared` is available in PATH.
 * Throws a descriptive error with install instructions if not found.
 */
export function detectCloudflared(): void {
  try {
    execFileSync("which", ["cloudflared"], { stdio: "ignore" });
  } catch {
    const platform = process.platform;
    let instructions: string;
    if (platform === "darwin") {
      instructions = "Install via Homebrew: brew install cloudflared";
    } else if (platform === "linux") {
      instructions =
        "Install via apt: sudo apt install cloudflared\n" +
        "Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
    } else {
      instructions =
        "Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
    }
    throw new Error(`cloudflared not found in PATH.\n${instructions}`);
  }
}
