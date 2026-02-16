import type { CloudflaredManager, TunnelConfig } from "./cloudflared-manager.js";

export interface TunnelRelayOptions {
  manager: CloudflaredManager;
  config: TunnelConfig;
}

/**
 * Manages the cloudflared sidecar lifecycle as part of the daemon.
 * Provides start/stop semantics and tunnel URL access.
 */
export class TunnelRelayAdapter {
  private manager: CloudflaredManager;
  private config: TunnelConfig;
  private _tunnelUrl: string | null = null;

  constructor(options: TunnelRelayOptions) {
    this.manager = options.manager;
    this.config = options.config;
  }

  get tunnelUrl(): string | null {
    return this._tunnelUrl;
  }

  get isRunning(): boolean {
    return this.manager.isRunning();
  }

  async start(): Promise<string> {
    const { url } = await this.manager.start(this.config);
    this._tunnelUrl = url;
    return url;
  }

  async stop(): Promise<void> {
    await this.manager.stop();
    this._tunnelUrl = null;
  }
}
