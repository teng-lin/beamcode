# BackendAdapter Implementor Guide

This guide walks you through implementing a new `BackendAdapter` for BeamCode. A backend adapter translates between BeamCode's `UnifiedMessage` envelope and a specific coding-agent protocol (SdkUrl/NDJSON, ACP, Codex, etc.).

## Architecture overview

```
┌──────────┐     UnifiedMessage     ┌─────────────────┐    Protocol-specific    ┌─────────┐
│ Consumer │ ◄─────────────────────► │ BackendAdapter  │ ◄────────────────────► │ Backend │
│ (UI/API) │                        │ + BackendSession │                        │ (CLI)   │
└──────────┘                        └─────────────────┘                        └─────────┘
```

Adapters sit between BeamCode's core and the backend process. Consumers never touch protocol-specific messages — they work exclusively with `UnifiedMessage`.

## Core interfaces

### BackendAdapter

```typescript
interface BackendAdapter {
  readonly name: string;                       // e.g. "sdk-url", "acp", "codex"
  readonly capabilities: BackendCapabilities;
  connect(options: ConnectOptions): Promise<BackendSession>;
}
```

- **`name`** — A human-readable identifier. Used in logs, metrics, and error messages.
- **`capabilities`** — Static declaration of what this adapter supports (see below).
- **`connect()`** — Opens a new session (or resumes an existing one). Returns a `BackendSession`. Must reject the promise on connection failure.

### BackendCapabilities

```typescript
interface BackendCapabilities {
  streaming: boolean;        // Can the backend stream partial responses?
  permissions: boolean;      // Does it handle permission requests natively?
  slashCommands: boolean;    // Does it support slash commands?
  availability: "local" | "remote" | "both";
}
```

Consumers inspect capabilities to adapt their UI. For example, a non-streaming backend shows a spinner instead of incremental text.

### ConnectOptions

```typescript
interface ConnectOptions {
  sessionId: string;                          // Target session ID
  resume?: boolean;                           // Attempt to resume existing session
  adapterOptions?: Record<string, unknown>;   // Adapter-specific (e.g. claudeBinary path)
}
```

`adapterOptions` is an escape hatch for protocol-specific configuration that doesn't belong in the common interface. Document your adapter's supported keys.

### BackendSession

```typescript
interface BackendSession {
  readonly sessionId: string;
  send(message: UnifiedMessage): void;
  readonly messages: AsyncIterable<UnifiedMessage>;
  close(): Promise<void>;
}
```

- **`sessionId`** — Must match the `sessionId` passed to `connect()`.
- **`send()`** — Translates a `UnifiedMessage` into the backend's wire format and sends it. Must throw if the session is closed.
- **`messages`** — An `AsyncIterable` that yields incoming `UnifiedMessage`s from the backend. Terminates (returns `done: true`) when the session is closed.
- **`close()`** — Gracefully shuts down the session. After `close()`, the `messages` iterable must terminate and `send()` must throw.

## Lifecycle

Every session follows a strict lifecycle:

```
connect() ──► send() / messages ──► close()
   │               ▲    │              │
   │               └────┘              │
   │          (bidirectional)          │
   ▼                                   ▼
 Promise<BackendSession>          messages done: true
                                  send() throws
```

### Step by step

1. **Connect**: Call `adapter.connect({ sessionId })`. The adapter spawns or connects to the backend process and returns a `BackendSession`.
2. **Send messages**: Call `session.send(msg)` with `UnifiedMessage` instances. Your adapter translates these to the backend's wire format.
3. **Receive messages**: Consume `session.messages` via `for await...of` or the async iterator protocol. Your adapter translates incoming wire-format messages into `UnifiedMessage`.
4. **Close**: Call `session.close()`. The adapter tears down the connection. The `messages` iterable terminates.

### Invariants

- `send()` after `close()` **must throw** with a descriptive error (e.g. `"Session is closed"`).
- `close()` **must cause** the `messages` async iterable to return `{ done: true }`.
- Multiple concurrent sessions from the same adapter **must be isolated** — closing one session must not affect others.
- `connect()` **must reject** the promise on connection failure rather than returning a broken session.

## UnifiedMessage

All messages flowing through BeamCode use the `UnifiedMessage` envelope:

```typescript
interface UnifiedMessage {
  id: string;                        // UUID v4 (auto-generated via createUnifiedMessage)
  timestamp: number;                 // Unix epoch milliseconds
  type: UnifiedMessageType;          // Semantic type (see below)
  role: UnifiedRole;                 // "user" | "assistant" | "system" | "tool"
  content: UnifiedContent[];         // Rich content blocks
  metadata: Record<string, unknown>; // Primary data carrier for non-chat messages
  parentId?: string;                 // Optional threading
}
```

### Message types

| Type                   | Direction        | Description                        |
|------------------------|------------------|------------------------------------|
| `session_init`         | backend → consumer | Backend initialization payload    |
| `status_change`        | backend → consumer | Status update (idle, busy, etc.)  |
| `assistant`            | backend → consumer | Assistant response (may stream)   |
| `result`               | backend → consumer | Final result of a turn            |
| `stream_event`         | backend → consumer | Streaming partial content         |
| `permission_request`   | backend → consumer | Tool permission request           |
| `control_response`     | backend → consumer | Response to a control message     |
| `tool_progress`        | backend → consumer | Tool execution progress           |
| `tool_use_summary`     | backend → consumer | Summary of tool invocation        |
| `auth_status`          | backend → consumer | Authentication status             |
| `user_message`         | consumer → backend | User's chat message               |
| `permission_response`  | consumer → backend | Allow/deny a permission request   |
| `interrupt`            | consumer → backend | Cancel in-flight work             |
| `configuration_change` | consumer → backend | Change model/permission mode      |
| `unknown`              | either             | Forward-compat passthrough        |

### Creating messages

Use the `createUnifiedMessage()` factory to auto-generate `id` and `timestamp`:

```typescript
import { createUnifiedMessage } from "../types/unified-message.js";

const msg = createUnifiedMessage({
  type: "assistant",
  role: "assistant",
  content: [{ type: "text", text: "Hello!" }],
  metadata: { inResponseTo: requestId },
});
```

### Validating messages

Use `isUnifiedMessage()` for runtime validation of unknown values:

```typescript
import { isUnifiedMessage } from "../types/unified-message.js";

if (isUnifiedMessage(parsed)) {
  session.send(parsed);
}
```

## UnifiedMessage mapping

Every adapter needs two translators:

1. **Outbound** (backend → consumer): Convert your protocol's wire messages into `UnifiedMessage`.
2. **Inbound** (consumer → backend): Convert `UnifiedMessage` into your protocol's wire format.

Both should be pure functions — no side effects, no state mutation, no I/O. This makes them trivially testable.

### Outbound translator example (SdkUrl)

The SdkUrl adapter translates CLI NDJSON messages into `UnifiedMessage` via a switch on the message type. See `src/adapters/sdk-url/message-translator.ts`:

```typescript
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { CLIMessage } from "../../types/cli-messages.js";

export function translate(msg: CLIMessage): UnifiedMessage | null {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init"
        ? createUnifiedMessage({
            type: "session_init",
            role: "system",
            metadata: { session_id: msg.session_id, model: msg.model, ... },
          })
        : createUnifiedMessage({
            type: "status_change",
            role: "system",
            metadata: { status: msg.status, ... },
          });
    case "assistant":
      return createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: msg.message.content.map(translateContentBlock),
        metadata: { message_id: msg.message.id, model: msg.message.model, ... },
      });
    case "keep_alive":
      return null; // Silently consumed — not forwarded
    // ... other cases
  }
}
```

Key patterns:
- Return `null` for messages that should be silently consumed (e.g. keep-alive pings).
- Map your protocol's message type to the closest `UnifiedMessageType`.
- Put protocol-specific fields in `metadata` — it's the primary data carrier for non-chat messages.
- Map rich content blocks (text, tool_use, tool_result, images) into `UnifiedContent[]`.

### Inbound translator example (SdkUrl)

The reverse path converts `UnifiedMessage` into the CLI's NDJSON format. See `src/adapters/sdk-url/inbound-translator.ts`:

```typescript
export function toNDJSON(msg: UnifiedMessage): string | null {
  switch (msg.type) {
    case "user_message":
      return JSON.stringify({
        type: "user",
        message: { role: "user", content: extractText(msg) },
        session_id: msg.metadata.session_id || "",
      });
    case "permission_response":
      return JSON.stringify({
        type: "control_response",
        response: {
          request_id: msg.metadata.request_id,
          response: { behavior: msg.metadata.behavior, ... },
        },
      });
    case "interrupt":
      return JSON.stringify({
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "interrupt" },
      });
    default:
      return null; // Not all message types need wire representation
  }
}
```

### Type mapping reference

| Your protocol message    | UnifiedMessageType       | Role        |
|--------------------------|--------------------------|-------------|
| Session initialization   | `session_init`           | `system`    |
| Status update            | `status_change`          | `system`    |
| Assistant response       | `assistant`              | `assistant` |
| Final result             | `result`                 | `system`    |
| Streaming chunk          | `stream_event`           | `system`    |
| Permission request       | `permission_request`     | `system`    |
| Tool progress            | `tool_progress`          | `tool`      |
| Tool use summary         | `tool_use_summary`       | `tool`      |
| Auth status              | `auth_status`            | `system`    |
| User message             | `user_message`           | `user`      |
| Permission response      | `permission_response`    | `user`      |
| Interrupt/cancel         | `interrupt`              | `user`      |
| Config change            | `configuration_change`   | `user`      |
| Heartbeat / keep-alive   | *return `null`*          | —           |

### Organizing translator files

Follow the SdkUrl pattern — keep translators in separate files next to your adapter:

```
src/adapters/my-backend/
  my-backend-adapter.ts        # BackendAdapter implementation
  my-backend-session.ts        # BackendSession implementation
  outbound-translator.ts       # Protocol → UnifiedMessage
  outbound-translator.test.ts
  inbound-translator.ts        # UnifiedMessage → Protocol
  inbound-translator.test.ts
```

## Extension interfaces

Extensions are additive capabilities that a session MAY implement. Consumers detect support via runtime type narrowing — never assume an extension is present.

### Interruptible

```typescript
interface Interruptible {
  interrupt(): void;
}
```

Cancels in-flight work. Implement this if your backend supports interruption (e.g. sending SIGINT to a CLI process).

### Configurable

```typescript
interface Configurable {
  setModel(model: string): void;
  setPermissionMode(mode: string): void;
}
```

Allows runtime configuration changes without reconnecting. Implement this if your backend supports mid-session reconfiguration.

### PermissionHandler

```typescript
interface PermissionHandler {
  readonly permissionRequests: AsyncIterable<PermissionRequestEvent>;
  respondToPermission(requestId: string, behavior: "allow" | "deny"): void;
}

interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}
```

Surfaces tool permission requests as a separate async stream, with a method to respond. Implement this if your backend surfaces permission requests that require user approval.

### Runtime narrowing pattern

Consumers check for extension support at runtime:

```typescript
const session = await adapter.connect({ sessionId: "s-1" });

// Check before using
if ("interrupt" in session) {
  (session as BackendSession & Interruptible).interrupt();
}

if ("setModel" in session) {
  (session as BackendSession & Configurable).setModel("claude-opus-4-6");
}
```

### Phase 2 extensions (defined, not yet active)

These are defined for forward compatibility but not required for Phase 0-1 adapters:

- **`Reconnectable`** — Disconnect recovery and message replay from a sequence number.
- **`Encryptable`** — End-to-end encryption of message envelopes.

## Step-by-step: implementing a new adapter

### 1. Create the session class

```typescript
// src/adapters/my-backend/my-backend-session.ts

import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { Interruptible } from "../../core/interfaces/extensions.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";

export class MyBackendSession implements BackendSession, Interruptible {
  readonly sessionId: string;
  private closed = false;

  // Use a message channel pattern for the async iterable
  private queue: UnifiedMessage[] = [];
  private resolve: ((result: IteratorResult<UnifiedMessage>) => void) | null = null;
  private done = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");
    // Translate UnifiedMessage → your backend's wire format and send
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<UnifiedMessage>> => {
          if (this.queue.length > 0) {
            return Promise.resolve({ value: this.queue.shift()!, done: false });
          }
          if (this.done) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise((r) => { this.resolve = r; });
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  interrupt(): void {
    // Send interrupt signal to your backend
  }

  // Call this when you receive a message from the backend
  protected pushMessage(msg: UnifiedMessage): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }
}
```

### 2. Create the adapter class

Model this after `SdkUrlAdapter` (`src/adapters/sdk-url/sdk-url-adapter.ts`):

```typescript
// src/adapters/my-backend/my-backend-adapter.ts

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { MyBackendSession } from "./my-backend-session.js";

export class MyBackendAdapter implements BackendAdapter {
  readonly name = "my-backend";

  // Declare capabilities honestly — consumers adapt behavior based on these
  readonly capabilities: BackendCapabilities = {
    streaming: true,     // Does your backend stream partial responses?
    permissions: false,   // Does it surface permission requests natively?
    slashCommands: false, // Does it support slash commands?
    availability: "local",// "local", "remote", or "both"
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    // 1. Establish connection to your backend
    // 2. Create a session
    // 3. Wire incoming messages to session.pushMessage()
    // 4. If options.resume, attempt to restore previous conversation
    // 5. Return the session — or throw on failure
    try {
      const session = new MyBackendSession(options.sessionId);
      // ... wire your transport here ...
      return session;
    } catch (err) {
      throw new Error(`Failed to connect to my-backend: ${err}`);
    }
  }
}
```

### 3. Write message translator tests

Test your translators independently. Each test verifies a single message type mapping:

```typescript
// src/adapters/my-backend/outbound-translator.test.ts
import { translate } from "./outbound-translator.js";
import { isUnifiedMessage } from "../../core/types/unified-message.js";

it("translates assistant response to UnifiedMessage", () => {
  const wireMsg = { type: "response", text: "Hello!", model: "gpt-4" };
  const result = translate(wireMsg);

  expect(result).not.toBeNull();
  expect(isUnifiedMessage(result)).toBe(true);
  expect(result!.type).toBe("assistant");
  expect(result!.role).toBe("assistant");
  expect(result!.content[0]).toEqual({ type: "text", text: "Hello!" });
});

it("returns null for heartbeat messages", () => {
  expect(translate({ type: "ping" })).toBeNull();
});
```

### 4. Verify against the contract test suite

The contract test suite at `src/core/interfaces/backend-adapter.test.ts` defines the behavioral contract every adapter must satisfy. Use it as your compliance checklist.

**What the contract tests verify:**

| Test                                          | Invariant                                          |
|-----------------------------------------------|---------------------------------------------------|
| "exposes a name"                              | `adapter.name` is defined                         |
| "exposes capabilities"                        | All capability fields are present                 |
| "connects and returns a session"              | `session.sessionId` matches `ConnectOptions`      |
| "sends a message and receives a response"     | `send()` → `messages` round-trip works            |
| "close() terminates the message stream"       | Iterator returns `{ done: true }` after close     |
| "send() throws after close()"                 | Synchronous throw with descriptive message        |
| "connect() rejects on connection failure"     | Promise rejects (not a broken session)            |
| "supports multiple concurrent sessions"       | Each session's messages are independent           |
| "closing one session does not affect another"  | Session isolation                                 |
| "accepts resume option"                       | `resume: true` does not throw                     |
| "accepts adapterOptions"                      | Pass-through of adapter-specific config           |

**Extension interface tests:**

| Test                                          | Invariant                                          |
|-----------------------------------------------|---------------------------------------------------|
| "Interruptible: session can be interrupted"   | `interrupt()` is callable                          |
| "Configurable: model can be changed"          | `setModel()` persists                              |
| "Configurable: permission mode can be changed"| `setPermissionMode()` persists                     |
| "runtime narrowing: check for Interruptible"  | `"interrupt" in session` works                     |
| "runtime narrowing: check for Configurable"   | `"setModel" in session` works                      |
| "PermissionHandler"                           | Async iterable + respondToPermission round-trip    |

**Using the contract tests as a template:**

The `MockAdapter` and `MockSession` in the test file serve as a minimal reference implementation. Copy their structure as your starting point — they demonstrate:

- The `createMessageChannel()` pattern for the `messages` async iterable
- How `send()` should check for closed state before processing
- How `close()` should terminate the message channel
- How to implement extensions alongside `BackendSession`

### 5. Export from the adapters barrel

Add your adapter to the project's export surface:

```typescript
// src/index.ts
export { MyBackendAdapter } from "./adapters/my-backend/my-backend-adapter.js";
```

## Error handling

- **Connection failures**: `connect()` must reject the promise with a descriptive `Error`. Never return a half-initialized session.
- **Send after close**: `send()` must throw synchronously. The error message should indicate the session is closed.
- **Backend crashes**: Push any final messages to the `messages` iterable, then terminate it (`done: true`). The consumer will observe the stream ending and can decide whether to reconnect.
- **Invalid messages from backend**: Validate with `isUnifiedMessage()` before pushing to the consumer. Drop or log invalid messages — do not crash.

## Checklist

Before shipping a new adapter:

- [ ] Implements `BackendAdapter` and `BackendSession` interfaces
- [ ] `capabilities` accurately reflects backend support
- [ ] `connect()` rejects on failure
- [ ] `send()` throws after `close()`
- [ ] `close()` terminates `messages` iterable
- [ ] Concurrent sessions are isolated
- [ ] Extension interfaces are declared only if genuinely supported
- [ ] Runtime narrowing (`"interrupt" in session`) works for all implemented extensions
- [ ] Outbound translator converts all protocol message types to `UnifiedMessage`
- [ ] Inbound translator converts relevant `UnifiedMessage` types to wire format
- [ ] Translator functions are pure (no side effects, no state, no I/O)
- [ ] Translators return `null` for messages that should be silently consumed
- [ ] Uses `createUnifiedMessage()` for outgoing messages
- [ ] Validates incoming messages with `isUnifiedMessage()`
- [ ] Translator tests cover each message type mapping
- [ ] Error messages are descriptive and actionable
- [ ] Exported from `src/index.ts`
