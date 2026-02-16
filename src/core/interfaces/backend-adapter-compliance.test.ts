import type { UnifiedMessage } from "../types/unified-message.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./backend-adapter.js";
import { runBackendAdapterComplianceTests } from "./backend-adapter-compliance.js";

// ---------------------------------------------------------------------------
// Minimal echo adapter for compliance testing
// ---------------------------------------------------------------------------

function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  let done = false;

  return {
    push(msg: UnifiedMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as unknown as UnifiedMessage, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
      return {
        next(): Promise<IteratorResult<UnifiedMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as UnifiedMessage,
              done: true,
            });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

class EchoSession implements BackendSession {
  readonly sessionId: string;
  private channel = createMessageChannel();
  private closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");
    const response = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: `echo: ${message.id}` }],
      metadata: { inResponseTo: message.id },
    });
    this.channel.push(response);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.channel.close();
  }
}

class EchoAdapter implements BackendAdapter {
  readonly name = "echo";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: false,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    return new EchoSession(options.sessionId);
  }
}

// ---------------------------------------------------------------------------
// Run the compliance suite
// ---------------------------------------------------------------------------

runBackendAdapterComplianceTests("EchoAdapter", () => new EchoAdapter());
