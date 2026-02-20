import type { AuthContext } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type { CliAdapterName } from "./interfaces/adapter-names.js";
import type { InvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import { isInvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import type {
  SessionTransportHub as ISessionTransportHub,
  SessionTransportHubDeps,
} from "./interfaces/session-manager-coordination.js";

export class SessionTransportHub implements ISessionTransportHub {
  private server: SessionTransportHubDeps["server"];

  constructor(private deps: SessionTransportHubDeps) {
    this.server = deps.server;
  }

  setServer(server: SessionTransportHubDeps["server"]): void {
    this.server = server;
  }

  async start(): Promise<void> {
    if (!this.server) return;

    await this.server.listen(
      (socket, sessionId) => this.handleCliConnection(socket, sessionId),
      (socket, context) => this.handleConsumerConnection(socket, context),
    );
    this.deps.logger.info(`WebSocket server listening on port ${this.deps.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.close();
  }

  private handleCliConnection(
    socket: WebSocketLike & {
      on(event: "message", handler: (data: string | Buffer) => void): void;
      on(event: "close", handler: () => void): void;
      on(event: "error", handler: (err: Error) => void): void;
    },
    sessionId: string,
  ): void {
    const info = this.deps.launcher.getSession(sessionId);
    if (!info || info.state !== "starting") {
      this.deps.logger.warn(
        `Rejecting unexpected CLI connection for session ${sessionId} (state=${info?.state ?? "unknown"})`,
      );
      socket.close();
      return;
    }

    // Resolve the adapter for this session and verify it supports inverted connections
    const adapterName = info.adapterName;
    let invertedAdapter: InvertedConnectionAdapter | null = null;
    if (adapterName && this.deps.adapterResolver) {
      const resolved = this.deps.adapterResolver.resolve(adapterName as CliAdapterName);
      if (isInvertedConnectionAdapter(resolved)) {
        invertedAdapter = resolved;
      }
    } else if (this.deps.adapter && isInvertedConnectionAdapter(this.deps.adapter)) {
      invertedAdapter = this.deps.adapter;
    }

    if (!invertedAdapter) {
      this.deps.logger.warn(
        `No adapter configured, cannot handle CLI connection for session ${sessionId}`,
      );
      socket.close();
      return;
    }

    const adapter = invertedAdapter;
    const buffered: unknown[] = [];
    let buffering = true;
    let replayed = false;
    socket.on("message", (data: unknown) => {
      if (buffering) buffered.push(data);
    });

    const socketForAdapter = {
      send: (data: string) => socket.send(data),
      close: (code?: number, reason?: string) => socket.close(code, reason),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      on: ((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "message") {
          socket.on("message", handler as (data: string | Buffer) => void);
        } else if (event === "close") {
          socket.on("close", handler as () => void);
        } else if (event === "error") {
          socket.on("error", handler as (err: Error) => void);
        } else {
          return;
        }
        if (event === "message" && !replayed) {
          replayed = true;
          for (const msg of buffered) {
            handler(msg);
          }
          buffered.length = 0;
          buffering = false;
        }
      }) as typeof socket.on,
    };

    this.deps.bridge.setAdapterName(sessionId, adapterName ?? this.deps.adapter?.name ?? "unknown");
    this.deps.bridge
      .connectBackend(sessionId)
      .then(() => {
        const ok = adapter.deliverSocket(sessionId, this.deps.toAdapterSocket(socketForAdapter));
        if (!ok) {
          adapter.cancelPending(sessionId);
          this.deps.logger.warn(`Failed to deliver socket for session ${sessionId}, closing`);
          socket.close();
        }
      })
      .catch((err) => {
        adapter.cancelPending(sessionId);
        this.deps.logger.warn(`Failed to connect backend for session ${sessionId}: ${err}`);
        socket.close();
      });
  }

  private handleConsumerConnection(
    socket: WebSocketLike & {
      on(event: "message", handler: (data: string | Buffer) => void): void;
      on(event: "close", handler: () => void): void;
      on(event: "error", handler: (err: Error) => void): void;
    },
    context: AuthContext,
  ): void {
    this.deps.bridge.handleConsumerOpen(socket, context);
    socket.on("message", (data) => {
      this.deps.bridge.handleConsumerMessage(socket, context.sessionId, data);
    });
    socket.on("close", () => this.deps.bridge.handleConsumerClose(socket, context.sessionId));
  }
}
