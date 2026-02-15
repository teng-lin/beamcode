# Protocol Design Assessment: Universal Adapter Layer

## Executive Summary

The RFC proposes a **sound architectural vision** with **well-researched protocol patterns**, but the current implementation reveals **7 critical protocol gaps** that will prevent the universal adapter layer from working as intended. The good news: **all are addressable** through incremental refactoring.

**Overall Grade: B+ (Architecture) / C (Implementation Readiness)**

---

## 1. UnifiedMessage Fidelity ⚠️ **CRITICAL GAP**

### Current State
The RFC defines `UnifiedMessage` as SDK-aligned (lines 924-1119), but **the actual implementation uses a different type hierarchy**:

```typescript
// RFC proposes:
type UnifiedMessage = 
  | { type: 'assistant_message', messageId, model, content, usage, ... }
  | { type: 'partial_message', event, parentToolUseId }
  | { type: 'result', subtype, cost, turns, ... }
  
// Current implementation uses:
type CLIMessage = CLISystemInitMessage | CLIAssistantMessage | ...
type ConsumerMessage = { type: 'assistant', message: ... } | ...
```

**The proposed UnifiedMessage type doesn't exist in the codebase yet.** The bridge currently has:
- `CLIMessage` (from CLI via NDJSON)
- `ConsumerMessage` (to consumers via WebSocket)
- Direct translation in `routeCLIMessage()` without an intermediate unified format

### Fidelity Issues

1. **No ACP representation**: The current types only handle Claude Code's NDJSON protocol. ACP messages like `session/update`, `session/request_permission`, or streaming chunks have no representation.

2. **Type name misalignment**: RFC says `assistant_message`, code has `{ type: "assistant", message: {...} }`. This will break if SDK adapter is added.

3. **Missing message types**: RFC includes `task_notification`, `hook_event`, `compact_boundary` — **none exist** in current `ConsumerMessage`.

4. **Content block parity incomplete**: RFC has `thinking` blocks with `budget_tokens` (line 1118), current code has it (line 207), but consumers don't receive `thinking` blocks separately — they're buried in `stream_event.event` as opaque `unknown`.

### Recommendation
**PRIORITY 1**: Implement `UnifiedMessage` as the RFC defines it. Make adapters produce `UnifiedMessage`, make SessionBridge consume it, translate to `ConsumerMessage` only at the broadcast boundary.

---

## 2. Translation Loss 🔴 **HIGH RISK**

### What Gets Lost Today

**CLI → Consumer translation** (`routeCLIMessage`, lines 730-766):

| Source (CLIMessage) | Destination (ConsumerMessage) | Lost Data |
|---------------------|------------------------------|-----------|
| `uuid`, `session_id` | Not forwarded | **Message correlation breaks** across multi-session scenarios |
| `stream_event.event` | Opaque `unknown` | **All streaming delta structure** (message_start, content_block_delta, thinking deltas) |
| `tool_progress.parent_tool_use_id` | Dropped | **Subagent tool progress** untraceable |
| `result.modelUsage` | Forwarded but **not in message history** | Consumers joining late **miss per-model token usage** |

**Consumer → CLI translation** (`routeConsumerMessage`):

| Source (InboundMessage) | Destination (CLI NDJSON) | Lost Data |
|-------------------------|-------------------------|-----------|
| Permission response `message` field | Wrapped in `response.message` | **None** ✅ |
| Images in `user_message` | Converted to content blocks | **media_type normalization risk** if consumer sends non-standard MIME types |

### ACP → Unified → Consumer (hypothetical)

The RFC doesn't specify **how ACP session/update notifications map to ConsumerMessage**. ACP has:

```jsonc
// ACP session/update
{
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "type": "message_chunk",  // or tool_call, permission_request, etc.
      "content": {...}
    }
  }
}
```

**Without a defined mapping**, adapters will make inconsistent choices. For example:
- Should `message_chunk` → `stream_event` or `partial_message`?
- Does ACP's `terminal/output` map to a new `ConsumerMessage` type or get dropped?

### Recommendation
**PRIORITY 2**: Document **lossless translation tables** in the adapter interface. Each adapter MUST specify what source fields map to which `UnifiedMessage` fields, and what gets intentionally dropped (with rationale).

---

## 3. Push vs Pull Gap 🟡 **DESIGN IMPEDANCE**

### The Mismatch

The RFC correctly identifies this (line 1140):

> "SDK uses a pull model (the caller iterates the generator and handles canUseTool via callback), while the bridge uses a push model (messages are broadcast to multiple consumers, permissions are requested via messages)"

But the proposed solution is **incomplete**:

```typescript
// RFC line 1176 (AgentSdkAdapter):
respondToPermission(): fulfilled via canUseTool callback's Promise resolution
```

**Problem**: The SDK's `canUseTool` callback is invoked **during** the `query()` iteration. The bridge broadcasts permission requests to **all consumers**, but **only one consumer's response** should resolve the callback. How do you handle:

1. **Multiple consumers respond** (participant A allows, participant B denies)
2. **Observer tries to respond** (should be rejected at protocol level, not just RBAC)
3. **Consumer disconnects before responding** (callback Promise never resolves → agent hangs)
4. **Permission response arrives after agent has already timed out locally**

### Current Implementation
The bridge handles CLI control_request → broadcast → first consumer response → CLI control_response (lines 896-920, 650-699). This is **push-to-push**, which works.

For SDK (pull), the adapter needs a **Promise registry**:

```typescript
class AgentSdkAdapter {
  private pendingPermissions = new Map<string, {
    resolve: (result: PermissionResult) => void,
    reject: (err: Error) => void,
    timer: NodeJS.Timeout
  }>();
  
  async canUseTool(toolName, input) {
    const requestId = randomUUID();
    // Emit to bridge as UnifiedMessage
    this.emit('permission_request', { requestId, toolName, input });
    
    // Wait for bridge to call adapter.respondToPermission()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 30000);
      this.pendingPermissions.set(requestId, { resolve, reject, timer });
    });
  }
  
  respondToPermission(requestId, decision) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return; // already resolved or unknown
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
  }
}
```

**This is doable but NOT documented in the RFC.**

### Recommendation
**PRIORITY 3**: Add explicit **Promise-to-Message bridging pattern** to the adapter interface spec. Document multi-consumer conflict resolution (first response wins? participant-only? configurable?).

---

## 4. Version Negotiation ❌ **MISSING**

### Current State
**No version negotiation exists.** Consumers discover capabilities via:

1. **Implicit**: They parse `ConsumerMessage` types and see what fields exist
2. **Partial**: `capabilities_ready` message (line 71-75) sends `commands`, `models`, `account` but **not supported message types**
3. **Trial and error**: Send `slash_command`, if bridge doesn't recognize it, get an error

### What's Missing

- **Consumer protocol version**: What if a new consumer sends `{ type: "fork_session" }` to an old bridge?
- **UnifiedMessage version**: When ACP adds `session/update` variants, how do consumers know if the bridge supports them?
- **Adapter capabilities**: RFC has `BackendCapabilities` (line 844-875), but it's not exposed to consumers. A consumer can't ask "does this session support `sessionFork`?"

### Recommendation
**PRIORITY 4**: Add **handshake protocol**:

```typescript
// Consumer → Bridge on connect
{ type: "client_hello", protocolVersion: "1.0.0", supportedExtensions: ["fork", "agent_teams"] }

// Bridge → Consumer
{ type: "server_hello", protocolVersion: "1.0.0", supportedMessageTypes: [...], backendCapabilities: {...} }
```

Use **semantic versioning** for breaking changes. Reject incompatible clients gracefully.

---

## 5. Backpressure 🔴 **CRITICAL MISSING**

### Current State
**No backpressure handling.** The WebSocket abstraction (lines 1-5 in transport.ts) is:

```typescript
export interface WebSocketLike {
  send(data: string): void;  // ← fire-and-forget
  close(code?: number, reason?: string): void;
}
```

**No `pause()`, `resume()`, `drain` events.** The bridge broadcasts to all consumers (line 832):

```typescript
this.broadcastToConsumers(session, consumerMsg);
```

### What Happens With Slow Consumers

1. **Fast producer** (agent streaming tool outputs at 10 msg/sec)
2. **Slow consumer** (mobile on 3G, can only receive 2 msg/sec)
3. **Bridge keeps sending** → WebSocket buffer fills → **TCP backpressure** → bridge slows down → **ALL consumers (including fast ones) get throttled**

### What Happens With Fast Consumers

The bridge has **per-consumer rate limiting** (lines 536-564) using `TokenBucketLimiter`:

```typescript
config.consumerMessageRateLimit ?? { burstSize: 20, tokensPerSecond: 50 }
```

This limits **inbound messages** (consumer → bridge), not **outbound** (bridge → consumer). A malicious or buggy consumer **cannot** flood the bridge, ✅ but a **slow consumer still blocks the session** ❌.

### Recommendation
**PRIORITY 1**: Implement **per-consumer send queues with backpressure**:

```typescript
class ConsumerQueue {
  private queue: ConsumerMessage[] = [];
  private draining = false;
  
  enqueue(msg: ConsumerMessage) {
    this.queue.push(msg);
    if (this.queue.length > HIGH_WATER_MARK) {
      this.emit('backpressure'); // Signal to session: slow down CLI
    }
    this.maybeDrain();
  }
  
  async maybeDrain() {
    if (this.draining || !this.queue.length) return;
    this.draining = true;
    while (this.queue.length) {
      const msg = this.queue.shift()!;
      const canSend = this.ws.send(JSON.stringify(msg)); // ← check bufferedAmount
      if (!canSend) {
        await waitForDrain(this.ws);
      }
    }
    this.draining = false;
  }
}
```

**Alternative**: Drop messages for slow observers, only guarantee delivery to participants.

---

## 6. Message Ordering ⚠️ **PARTIAL GUARANTEES**

### Current Guarantees

| Transport | Ordering Guarantee | Implementation |
|-----------|-------------------|----------------|
| WebSocket (CLI ↔ Bridge) | ✅ **Per-session FIFO** | TCP guarantees + NDJSON line-by-line parsing (lines 14-31 ndjson.ts) |
| WebSocket (Bridge ↔ Consumer) | ✅ **Per-consumer FIFO** | Each consumer gets `ws.send()` calls in order |
| **Across consumers** | ❌ **No ordering** | Race condition: Consumer A receives msg N before Consumer B receives msg N-1 |

### Ordering Violations

**Scenario**: Permission request arrives, consumer A responds "allow", consumer B (observer) joins late.

1. Consumer B receives `message_history` (line 458-462)
2. History includes `permission_request` followed by agent's action
3. Consumer B never sees the `permission_cancelled` because it already resolved
4. **Consumer B UI shows pending permission that's already resolved** ❌

**Scenario**: Agent streams tool output via `stream_event`, consumer disconnects and reconnects.

1. Consumer rejoins, gets `message_history`
2. History includes `assistant_message` but **not the intermediate `stream_event` messages** (they're not stored, line 831)
3. Consumer sees final message but **can't replay the streaming animation** ❌

### Recommendation
**PRIORITY 3**: 
1. **Store all messages** (including `stream_event`, `tool_progress`) in `messageHistory`, not just terminal ones
2. Add **sequence numbers** to `ConsumerMessage`:
   ```typescript
   { type: "assistant", seq: 42, message: {...} }
   ```
3. Consumers can detect gaps and request retransmission

---

## 7. Dual ACP Role 🟡 **DESIGN COMPLEXITY**

### RFC Proposal (lines 1279-1327)

The bridge wants to be **both**:

1. **ACP Client** (consumes ACP agents like Goose, Kiro)
2. **ACP Server** (exposes sessions to ACP editors like Zed, Neovim)

### Impedance Mismatch Risks

**As ACP Client**:
- Bridge spawns subprocess, sends `initialize` request, gets capabilities
- Bridge sends `session/new`, gets session ID
- Bridge sends `session/prompt`, consumes `session/update` notifications
- **Bridge must implement ACP client state machine**

**As ACP Server**:
- Editor spawns bridge as subprocess (?) or connects via HTTP (?)
- Editor sends `initialize`, bridge responds with **bridge's capabilities** (not agent's!)
- Editor sends `session/new`, bridge creates... what? A new `SessionBridge` instance? A new backend adapter?
- Editor sends `session/prompt`, bridge forwards to... which agent?

**The conflict**: ACP assumes **1 client ↔ 1 agent**. The bridge is a **multiplexer** (many consumers, many sessions, many agents). The RFC doesn't specify:

1. Does each ACP editor get its own session ID?
2. If editor A and editor B both send `session/new`, do they get the same session or different sessions?
3. When editor A sends `session/prompt`, does it go to the CLI adapter or the ACP adapter for this session?

### Recommendation
**PRIORITY 2**: Clarify the **ACP server model**:

**Option A**: Bridge is a **transparent proxy**. Each ACP editor connection maps 1:1 to a bridge session, which maps 1:1 to a backend adapter.

```
Zed → stdin/stdout → Bridge (ACP server) → SessionBridge → ACPAdapter → Goose subprocess
```

**Option B**: Bridge is a **session manager**. Multiple editors can attach to the same session.

```
Zed A → HTTP → Bridge → SessionBridge → ACPAdapter → Goose
Zed B → HTTP → Bridge ↗
```

**My recommendation**: Option A for Phase 1. Option B requires **ACP extensions** (multi-attach, presence, RBAC) that don't exist in the spec.

---

## 8. Error Propagation ⚠️ **INCONSISTENT**

### Current Behavior

| Error Source | Propagation | Consumer Experience |
|--------------|-------------|-------------------|
| CLI parse error | `logger.warn()` only (line 332) | ❌ **Silent failure** |
| CLI disconnects | `{ type: "cli_disconnected" }` (line 353) | ✅ Visible |
| Permission timeout | Not implemented | ❌ **Agent hangs** |
| Rate limit exceeded | `{ type: "error", message: "Rate limit..." }` (line 559-562) | ✅ Visible |
| Auth failure | `ws.close(4001, "...")` (line 419) | ⚠️ **Connection drops**, no error message |
| Slash command PTY failure | `{ type: "slash_command_error", ... }` (line 65-69) | ✅ Visible |

### Missing Error Propagation

1. **CLI crashes**: Bridge detects disconnect but doesn't know **why**. Was it user Ctrl+C? OOM? Segfault? Consumer sees "CLI disconnected" with no details.

2. **Backend adapter errors**: If `ACPAdapter.createSession()` throws because Goose subprocess fails to start, who catches it? The RFC shows `createSession(): Promise<BackendSession>` but no error handling strategy.

3. **Control request failures**: If CLI responds with `{ subtype: "error", error: "..." }` to a `set_model` request (line 994-996), the bridge logs it but **doesn't notify the consumer** who sent the `set_model` inbound message.

4. **Consumer message parse failures**: Invalid JSON → warning + silent drop (line 518). Should send `{ type: "error", message: "Invalid JSON" }` to that consumer.

### Recommendation
**PRIORITY 3**: Adopt **structured error codes**:

```typescript
type ConsumerMessage = ... | {
  type: "error",
  code: "AUTH_FAILED" | "RATE_LIMIT" | "CLI_CRASHED" | "INVALID_REQUEST" | ...,
  message: string,
  recoverable: boolean,
  detail?: unknown
}
```

Document **error recovery strategies** (reconnect, retry, escalate to user).

---

## 9. Keep-alive Strategy ⚠️ **PARTIAL**

### Current Implementation

| Layer | Keep-alive | Implementation |
|-------|-----------|----------------|
| **Consumer ↔ Bridge** | ❌ None | WebSocket has no ping/pong in current code |
| **Bridge ↔ CLI** | ✅ `keep_alive` messages | CLI sends, bridge consumes (line 759-760) |
| **Bridge ↔ Adapter** | N/A | In-process (no network) |
| **Adapter ↔ Agent** | Depends on adapter | Not specified |

### Risks

1. **Consumer connection death**: If a mobile client goes into background, TCP connection may stay "open" for hours but be dead. Bridge won't know until it tries to send and gets EPIPE.

2. **Idle session reaping**: The bridge has an idle reaper (mentioned in session-manager.ts), but **consumers don't know** when their session is about to be reaped. No warning message.

3. **CLI connection death**: If the CLI subprocess dies but the WebSocket isn't closed properly (e.g., process kill -9), the bridge won't detect it until the next message send.

### Recommendation
**PRIORITY 2**: Implement **WebSocket ping/pong**:

```typescript
// Every 30 seconds, ping all consumers
setInterval(() => {
  for (const ws of session.consumerSockets.keys()) {
    ws.ping();
  }
}, 30000);

ws.on('pong', () => {
  // Reset dead connection timer
});
```

Send `{ type: "session_expiring", expiresIn: 300000 }` before idle reaper kills the session.

---

## 10. Protocol Evolution ✅ **SOUND DESIGN**

### Current State
The message type system is **extensible by design**:

```typescript
type ConsumerMessage = { type: "assistant", ... } | { type: "result", ... } | ...
```

Adding a new message type (e.g., `{ type: "agent_team_update", ... }`) is **backward-compatible** if:

1. Old consumers **ignore unknown types** (they should)
2. New message types are **optional** (don't replace existing ones)

### Risks

1. **Required new fields**: If a future version changes `assistant` to add a required field, old consumers will receive incomplete messages.

2. **Semantic changes**: If `permission_request.input` format changes (e.g., from `Record<string, unknown>` to a structured schema), old consumers may misinterpret it.

3. **No deprecation strategy**: How do you sunset `tool_use_summary` if it's replaced by a better mechanism?

### Recommendation
**PRIORITY 4**: Adopt **JSON Schema versioning** for message payloads:

```typescript
{
  type: "assistant",
  schemaVersion: "1.0.0",  // ← new field
  message: {...}
}
```

Consumers declare **minimum supported version** in handshake. Bridge rejects incompatible consumers.

---

## 11. Reverse Connection 🔴 **SECURITY & RELIABILITY RISK**

### Current Design (lines 1147-1159)

```
CLI connects TO bridge:
claude --sdk-url ws://127.0.0.1:3456/ws/cli/SESSION_ID
```

### Security Implications

1. **Port conflict**: If bridge binds to `0.0.0.0:3456`, **any process on the machine** can connect and inject malicious messages. Current code binds to `127.0.0.1` (line 58 node-ws-server.ts) ✅, but this is **not enforced** in the interface.

2. **Session ID guessing**: UUIDs are validated (line 73-75 node-ws-server.ts) ✅, but if an attacker knows a session ID, they can connect as the CLI and take over the session. **No CLI authentication.**

3. **TLS termination**: For remote access, the bridge needs TLS. But the CLI's `--sdk-url` doesn't support `wss://` validation (no cert pinning). **Man-in-the-middle risk.**

### Reliability Implications

1. **CLI can't reconnect if bridge restarts**: The CLI subprocess is launched with `--sdk-url ws://...`. If the bridge crashes and restarts on a new port, the CLI is stuck connecting to the old port.

2. **Race condition on startup**: SessionManager launches the CLI with `--sdk-url ws://...` after the bridge is listening (line 100-110 session-manager.ts). But if the CLI starts faster than the bridge, connection fails.

### Recommendation
**PRIORITY 1**: 

1. **Add CLI authentication**: Generate a random secret on session creation, pass it as `--sdk-url ws://localhost:3456/ws/cli/SESSION_ID?token=SECRET`. Bridge validates token before accepting connection.

2. **Make CLI reconnect-aware**: Add `--sdk-url-retry` flag to CLI (upstream change). If connection fails, retry with exponential backoff.

3. **For remote access**: Use a **relay** (as RFC describes, lines 1472-1642), NOT direct CLI→Bridge connections. The relay handles TLS, authentication, and routing.

---

## 12. Recommendations Summary

### Critical (Fix before Phase 1 ships)

1. **Implement UnifiedMessage type** (addresses #1, #2)
2. **Implement backpressure handling** (addresses #5)
3. **Add CLI authentication tokens** (addresses #11)

### High Priority (Fix during Phase 1 development)

4. **Document Promise-to-Message bridging** for AgentSdkAdapter (addresses #3)
5. **Clarify ACP server model** (addresses #7)
6. **Implement WebSocket ping/pong** (addresses #9)

### Medium Priority (Fix before Phase 2)

7. **Add protocol version handshake** (addresses #4)
8. **Store all messages in history** with sequence numbers (addresses #6)
9. **Adopt structured error codes** (addresses #8)

### Low Priority (Quality of life)

10. **JSON Schema versioning** for message payloads (addresses #10)

---

## Conclusion

The **universal adapter layer architecture is fundamentally sound**, but the **current implementation has NOT YET implemented it**. The gap between the RFC vision and the codebase is **significant but not insurmountable**.

**Key insight**: The RFC is a **roadmap**, not a **reflection of current state**. Treat it as such. The proposed `UnifiedMessage`, `BackendAdapter`, `BackendSession` types are **design artifacts** that need to be implemented from scratch.

**Strategic recommendation**: **Pause new adapter development** (OpenCode, Codex, Gemini) until the **core refactoring** (UnifiedMessage, backpressure, CLI auth) is complete. Building on the current foundation will require **rework** once the universal adapter layer lands.

**Estimated effort**: 
- Critical fixes: 2-3 weeks (1 engineer)
- High priority: 3-4 weeks (overlaps with critical)
- Medium priority: 2-3 weeks (after Phase 1)

**Total: 7-10 weeks** to production-ready universal adapter layer.

**Risk if not addressed**: The bridge will remain **Claude Code-only**, defeating the "universal" goal. Adapters built on the current implementation will need **significant rewrites** to fit the eventual UnifiedMessage abstraction.

---

## Appendix: Protocol Flow Diagrams

### Current Flow (NDJSON only)

```
CLI subprocess
  ↓ NDJSON line: {"type":"assistant",...}
  ↓ WebSocket message
SessionBridge.handleCLIMessage()
  ↓ parseNDJSON<CLIMessage>()
  ↓ routeCLIMessage()
  ↓ handleAssistantMessage()
  ↓ ConsumerMessage: {type:"assistant",message:{...}}
  ↓ broadcastToConsumers()
  ↓ ws.send(JSON.stringify(msg))
Consumer receives JSON
```

### Proposed Flow (Universal Adapter)

```
Agent subprocess (any protocol)
  ↓ Protocol-specific message
BackendAdapter
  ↓ Translate to UnifiedMessage
SessionBridge
  ↓ Translate UnifiedMessage → ConsumerMessage
  ↓ Broadcast to consumers
Consumer receives JSON
```

**The middle layer (UnifiedMessage) is the key to universality and doesn't exist yet.**

---

**Status**: Assessment complete. Ready for discussion. 🚀