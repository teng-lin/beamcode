import type { AuthContext } from "./auth.js";
import type { WebSocketLike } from "./transport.js";

/**
 * Callback invoked when a CLI WebSocket connects.
 */
export type OnCLIConnection = (
  socket: WebSocketLike & {
    on(event: "message", handler: (data: string | Buffer) => void): void;
    on(event: "close", handler: () => void): void;
    on(event: "error", handler: (err: Error) => void): void;
  },
  sessionId: string,
) => void;

/**
 * Callback invoked when a consumer WebSocket connects.
 */
export type OnConsumerConnection = (
  socket: WebSocketLike & {
    on(event: "message", handler: (data: string | Buffer) => void): void;
    on(event: "close", handler: () => void): void;
    on(event: "error", handler: (err: Error) => void): void;
  },
  context: AuthContext,
) => void;

/** Runtime-agnostic WebSocket server abstraction. */
export interface WebSocketServerLike {
  /** Start listening. Calls callbacks for CLI and consumer WebSocket connections. */
  listen(
    onCLIConnection: OnCLIConnection,
    onConsumerConnection?: OnConsumerConnection,
  ): Promise<void>;
  /** Stop the server and close all connections. */
  close(): Promise<void>;
}
