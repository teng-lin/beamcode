import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../core/types/unified-message.js";

type PendingResolver = {
  resolve: (value: IteratorResult<UnifiedMessage>) => void;
  reject: (reason?: unknown) => void;
};

class ControlledMessageStream implements AsyncIterable<UnifiedMessage> {
  private queue: UnifiedMessage[] = [];
  private pending: PendingResolver[] = [];
  private done = false;
  private failure: Error | null = null;

  push(message: UnifiedMessage): void {
    if (this.done || this.failure) return;
    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.pending) {
      waiter.resolve({ value: undefined, done: true });
    }
    this.pending = [];
  }

  fail(error: Error): void {
    if (this.done || this.failure) return;
    this.failure = error;
    for (const waiter of this.pending) {
      waiter.reject(error);
    }
    this.pending = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.pending.push({ resolve, reject });
        });
      },
    };
  }
}

export class FailureInjectionBackendSession implements BackendSession {
  readonly sentMessages: UnifiedMessage[] = [];
  readonly sentRawMessages: string[] = [];
  private closed = false;
  private stream = new ControlledMessageStream();

  constructor(readonly sessionId: string) {}

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.stream;
  }

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");
    this.sentMessages.push(message);
  }

  sendRaw(message: string): void {
    if (this.closed) throw new Error("Session is closed");
    this.sentRawMessages.push(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stream.end();
  }

  pushMessage(message: UnifiedMessage): void {
    this.stream.push(message);
  }

  failStream(error: Error): void {
    this.stream.fail(error);
  }

  endStream(): void {
    this.stream.end();
  }
}

export class FailureInjectionBackendAdapter implements BackendAdapter {
  readonly name: string;
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, FailureInjectionBackendSession>();
  private failConnectTimes = 0;
  connectAttempts = 0;

  constructor(options?: { name?: string; failConnectTimes?: number }) {
    this.name = options?.name ?? "failure-injection";
    this.failConnectTimes = options?.failConnectTimes ?? 0;
  }

  setFailConnectTimes(times: number): void {
    this.failConnectTimes = Math.max(0, times);
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    this.connectAttempts += 1;
    if (this.connectAttempts <= this.failConnectTimes) {
      throw new Error(`Injected connect failure #${this.connectAttempts}`);
    }
    const session = new FailureInjectionBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(sessionId: string): FailureInjectionBackendSession | undefined {
    return this.sessions.get(sessionId);
  }

  pushMessage(sessionId: string, message: UnifiedMessage): void {
    this.sessions.get(sessionId)?.pushMessage(message);
  }

  failStream(sessionId: string, error = new Error("Injected backend stream failure")): void {
    this.sessions.get(sessionId)?.failStream(error);
  }

  endStream(sessionId: string): void {
    this.sessions.get(sessionId)?.endStream();
  }
}
