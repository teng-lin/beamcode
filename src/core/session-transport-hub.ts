/**
 * SessionTransportHub — WebSocket server multiplexer for CLI and consumer connections.
 *
 * Listens on the configured port and routes incoming WebSocket connections to
 * either CliGateway (for inverted CLI connections) or ConsumerGateway (for
 * browser/mobile consumers). Owned by SessionCoordinator.
 *
 * @module SessionControl
 */

import type { AuthContext } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { CliGateway } from "./cli-gateway.js";
import type {
  SessionTransportHub as ISessionTransportHub,
  SessionTransportHubDeps,
} from "./interfaces/session-coordinator-coordination.js";

export class SessionTransportHub implements ISessionTransportHub {
  private server: SessionTransportHubDeps["server"];
  private readonly cliGateway: CliGateway;

  constructor(private deps: SessionTransportHubDeps) {
    this.server = deps.server;
    this.cliGateway = new CliGateway(deps);
  }

  setServer(server: SessionTransportHubDeps["server"]): void {
    this.server = server;
  }

  async start(): Promise<void> {
    if (!this.server) return;

    await this.server.listen(
      (socket, sessionId) => this.cliGateway.handleCliConnection(socket, sessionId),
      (socket, context) => this.handleConsumerConnection(socket, context),
    );
    this.deps.logger.info(`WebSocket server listening on port ${this.deps.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.close();
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
