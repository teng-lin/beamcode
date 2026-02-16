/** Runtime-agnostic WebSocket abstraction. Only the methods actually used by the bridge. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}
