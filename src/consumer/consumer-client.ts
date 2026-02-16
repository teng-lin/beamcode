import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { InboundMessage } from "../types/inbound-messages.js";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

/**
 * WebSocket client for connecting to a BeamCode bridge as a consumer.
 * Handles auto-reconnect with exponential backoff and message replay via last_seen_seq.
 */
export class ConsumerClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private consumerId: string;
  private lastSeenSeq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageCallbacks: Array<(msg: ConsumerMessage) => void> = [];
  private statusCallbacks: Array<(status: ConnectionStatus) => void> = [];
  private _status: ConnectionStatus = "disconnected";

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.consumerId = this.getOrCreateConsumerId();
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  connect(): void {
    if (this.ws) return;
    this.setStatus("connecting");

    const url = new URL(this.wsUrl);
    url.searchParams.set("consumer_id", this.consumerId);
    if (this.lastSeenSeq > 0) {
      url.searchParams.set("last_seen_seq", String(this.lastSeenSeq));
    }

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("connected");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as ConsumerMessage & { seq?: number };
        if (msg.seq != null) this.lastSeenSeq = msg.seq;
        for (const cb of this.messageCallbacks) cb(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.setStatus("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  send(message: InboundMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(callback: (msg: ConsumerMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): void {
    this.statusCallbacks.push(callback);
  }

  private getOrCreateConsumerId(): string {
    const key = "beamcode_consumer_id";
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    for (const cb of this.statusCallbacks) cb(status);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
