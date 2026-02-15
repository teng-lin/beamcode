# BeamCode Implementation Plan

**Date**: 2026-02-15
**Based on**: `docs/architecture/decisions.md` v2.2, `docs/architecture/architecture-diagram.md`
**Approach**: 1 engineer, sequential phases, relay-first MVP
**Total timeline**: 17-22 weeks (likely 19 weeks)

---

## Current State

The codebase (forked from `claude-code-bridge`) contains a working SdkUrl-only bridge:

- **SessionBridge** (`src/core/session-bridge.ts`, ~1,283 LOC) — monolithic bridge handling CLI↔consumer message routing, session state, permissions, message history, rate limiting
- **CLILauncher** (`src/core/cli-launcher.ts`, ~548 LOC) — process lifecycle, PID tracking, crash recovery, kill escalation
- **SessionManager** (`src/core/session-manager.ts`, ~340 LOC) — multi-session orchestration, auto-relaunch, reconnect, idle reaping
- **FileStorage** (`src/adapters/file-storage.ts`, ~213 LOC) — atomic writes with WAL pattern, UUID validation
- **NodeWebSocketServer** (`src/adapters/node-ws-server.ts`, ~124 LOC) — local WS server
- **Types** — `CLIMessage` (SdkUrl NDJSON), `ConsumerMessage`, `InboundMessage`, `SessionState`
- **Utilities** — NDJSON parser, ANSI strip, token bucket rate limiter, sliding window breaker
- **417 tests passing** across 12 test files

The bridge currently only speaks SdkUrl (NDJSON/WebSocket via `--sdk-url`). All CLI-specific logic is tightly coupled into `SessionBridge.routeCLIMessage()` and `SessionBridge.routeConsumerMessage()`.

---

## Phase 0: Foundation (2 weeks)

**Goal**: Design the universal type system and adapter interfaces that all subsequent phases build on. This is "Decision 0" — it blocks everything.

### 0.1 UnifiedMessage Type (3-4 days)

**Create**: `src/core/types/unified-message.ts`

Design a normalized message format that works across:
- SdkUrl: streaming NDJSON (assistant chunks, stream events, results)
- ACP: JSON-RPC request/response (synchronous tool calls, capability negotiation)
- Codex: Thread/Turn/Item model (conversation hierarchy, approval flows)

```typescript
interface UnifiedMessage {
  id: string;                           // Unique message ID (UUID)
  seq: number;                          // Sequence number (for reconnection)
  timestamp: number;                    // Unix ms
  type: UnifiedMessageType;             // Normalized type enum
  role: "user" | "assistant" | "system" | "tool";
  content: UnifiedContent[];            // Normalized content blocks
  metadata: Record<string, unknown>;    // Adapter-specific escape hatch
  parentId?: string;                    // For threading (Codex Turn→Thread)
}
```

**Key design constraints**:
- Message IDs and sequence numbers from day one (not bolted on later)
- Content blocks must support text, tool_use, tool_result, code, images
- Metadata escape hatch for adapter-specific fields without polluting the core type
- Unknown message types pass through (forward-compatible)
- Must serialize cleanly for E2E encryption (JSON.stringify deterministic)

**Tests**: Property-based tests for serialization roundtrip. Contract tests asserting SdkUrl CLIMessage → UnifiedMessage → ConsumerMessage lossless conversion.

**Abort trigger**: If SdkUrl and ACP message models can't be unified without > 30% information loss, stop and reconsider.

### 0.2 BackendAdapter & BackendSession Interfaces (3-4 days)

**Create**:
- `src/core/interfaces/backend-adapter.ts`
- `src/core/interfaces/backend-session.ts`
- `src/core/interfaces/extensions.ts` (composed interfaces)

```typescript
// Core — every adapter implements these
interface BackendAdapter {
  readonly name: string;                // "sdk-url" | "acp" | "codex" | ...
  connect(options: ConnectOptions): Promise<BackendSession>;
  capabilities: BackendCapabilities;
}

interface BackendSession {
  readonly sessionId: string;
  send(message: UnifiedMessage): void;
  readonly messages: AsyncIterable<UnifiedMessage>;
  close(): Promise<void>;
}

interface BackendCapabilities {
  streaming: boolean;                   // SdkUrl: true, ACP: false
  permissions: boolean;                 // SdkUrl: true, ACP: via sidecar
  slashCommands: boolean;              // SdkUrl: true, ACP: false (needs PTY)
  availability: "local" | "remote" | "both";
}

// Extensions — additive, not required
interface Interruptible { interrupt(): void; }
interface Configurable { setModel(model: string): void; setPermissionMode(mode: string): void; }
interface PermissionHandler { onPermissionRequest: AsyncIterable<PermissionRequest>; respondToPermission(id: string, behavior: string): void; }

// Relay-specific extensions (Phase 2)
interface Reconnectable { onDisconnect(callback: () => void): void; replay(fromSeq: number): AsyncIterable<UnifiedMessage>; }
interface Encryptable { encrypt(message: UnifiedMessage): EncryptedEnvelope; decrypt(envelope: EncryptedEnvelope): UnifiedMessage; }
```

**Tests**: Interface compliance test harness — a mock adapter that passes all contract tests. This becomes the template for real adapters.

### 0.3 Security Quick Wins (3-5 days)

**Modify**: `src/adapters/node-ws-server.ts`
**Create**: `src/server/origin-validator.ts`, `src/server/auth-token.ts`

1. **WebSocket origin validation** (1 day):
   - Reject connections from untrusted origins
   - Configurable allowlist (`localhost`, configured domains)
   - Default: reject all non-localhost origins

2. **CLI auth tokens** (2-4 days):
   - Generate per-session secret token on CLI spawn
   - CLI connects with `?token=SECRET` query param
   - Reject CLI connections without valid token
   - Token stored in session state, not in filesystem

**Tests**: Unit tests for origin validation logic. Integration test: CLI with wrong token rejected.

### 0.4 Phase 0 Deliverables Checklist

- [ ] `UnifiedMessage` type with serialization tests
- [ ] `BackendAdapter` / `BackendSession` interfaces with contract test harness
- [ ] Extension interfaces: `Interruptible`, `Configurable`, `PermissionHandler`
- [ ] Relay extension interfaces (defined, not implemented): `Reconnectable`, `Encryptable`
- [ ] `BackendCapabilities` type with `availability` mode
- [ ] WebSocket origin validation
- [ ] CLI auth token generation and verification
- [ ] All existing 417 tests still passing
- [ ] New types do NOT break existing SessionBridge (coexistence, not replacement)

---

## Phase 1: SdkUrl Adapter Extraction (3-4 weeks)

**Goal**: Extract SdkUrl-specific logic from SessionBridge into a clean `SdkUrlAdapter` that implements `BackendAdapter`.

### 1.1 Extract routeCLIMessage (1 week)

**Modify**: `src/core/session-bridge.ts`
**Create**: `src/adapters/sdk-url/sdk-url-adapter.ts`, `src/adapters/sdk-url/message-translator.ts`

SessionBridge currently has a 12-handler `routeCLIMessage()` method (~400 LOC) that translates SdkUrl NDJSON messages into ConsumerMessages. Extract this into:

1. `SdkUrlMessageTranslator`: CLIMessage → UnifiedMessage (pure function, no side effects)
2. `SdkUrlAdapter.send()`: UnifiedMessage → NDJSON string → CLI WebSocket
3. `SdkUrlAdapter.messages`: CLI WebSocket → NDJSON parse → UnifiedMessage (AsyncIterable)

**Message mapping** (CLIMessage → UnifiedMessage):
| CLIMessage type | UnifiedMessage type | Notes |
|---|---|---|
| `system/init` | `session_init` | Extract session metadata |
| `system/status` | `status_change` | Map status enum |
| `assistant` | `assistant` | Normalize content blocks |
| `result` | `result` | Preserve full result data in metadata |
| `stream_event` | `stream_event` | Passthrough event in metadata |
| `control/request` | `permission_request` | Extract permission details |
| `control/response` | `permission_response` | Map behavior field |

**Tests**: For each CLIMessage type, test roundtrip: CLIMessage → UnifiedMessage → ConsumerMessage produces identical output to current direct routing.

### 1.2 Extract CLILauncher → SdkUrlLauncher (3-4 days)

**Rename/Move**: `src/core/cli-launcher.ts` → `src/adapters/sdk-url/sdk-url-launcher.ts`

CLILauncher is already SdkUrl-specific (spawns `claude --sdk-url ws://...`). Move it into the sdk-url adapter directory and rename to `SdkUrlLauncher`.

The generic parts of process lifecycle management (spawn, kill, isAlive, crash recovery) remain in `ProcessManager` interface — they're used by the daemon later.

**Changes**:
- Rename class: `CLILauncher` → `SdkUrlLauncher`
- Rename file and update imports
- `SdkUrlAdapter.connect()` uses `SdkUrlLauncher` internally
- Update all existing tests (search-and-replace, not rewrite)

### 1.3 Generalize SessionState (3-4 days)

**Modify**: `src/types/session-state.ts`
**Create**: `src/core/types/core-session-state.ts`

Split current `SessionState` into:
- `CoreSessionState`: session_id, status, created_at, last_activity (adapter-agnostic)
- `SdkUrlSessionState extends CoreSessionState`: model, cwd, tools, permissionMode, etc.

**Modify**: `src/types/events.ts`

Generalize event names:
- `cli:connected` → `backend:connected`
- `cli:disconnected` → `backend:disconnected`
- `cli:message` → `backend:message`

Keep old event names as deprecated aliases for backwards compatibility during Phase 1 only. Remove in Phase 2.

### 1.4 Rewire SessionBridge (1 week)

**Modify**: `src/core/session-bridge.ts`

Refactor SessionBridge to consume `BackendAdapter` instead of directly handling CLI WebSockets:

**Before**: SessionBridge knows about CLIMessage, NDJSON, WebSocket connections
**After**: SessionBridge receives `UnifiedMessage` from adapter, routes to consumers

```typescript
class SessionBridge {
  constructor(options: {
    adapter: BackendAdapter;  // NEW: replaces direct CLI socket handling
    // ... existing options (storage, logger, metrics, etc.)
  }) {}
}
```

The bridge's `onCLIConnected()` / `onCLIMessage()` methods become internal to `SdkUrlAdapter`. SessionBridge only sees `UnifiedMessage` flow.

**Critical invariant**: All 417 existing tests must pass after this refactor. The external behavior is unchanged — only the internal plumbing moves.

**Tests**: Run full test suite. Add integration test: `SdkUrlAdapter` → `SessionBridge` → consumer receives same messages as before refactor.

### 1.5 Phase 1 Deliverables Checklist

- [ ] `SdkUrlAdapter` implements `BackendAdapter` interface
- [ ] `SdkUrlLauncher` (renamed from CLILauncher) in `src/adapters/sdk-url/`
- [ ] `SdkUrlMessageTranslator` with bidirectional CLIMessage↔UnifiedMessage
- [ ] `CoreSessionState` separated from `SdkUrlSessionState`
- [ ] Generalized event names (`backend:*`)
- [ ] SessionBridge consumes `BackendAdapter`, not raw CLIMessage
- [ ] All 417+ tests passing (target: 500+ with new adapter contract tests)
- [ ] Contract test: `SdkUrlAdapter` passes `BackendAdapter` compliance suite

**Abort trigger**: Phase 1 takes > 3 weeks → the abstraction is wrong, stop and redesign.

---

## Phase 2: Relay MVP (6-8 weeks)

**Goal**: Build the core product differentiator — mobile browser access to running Claude Code sessions via Cloudflare Tunnel with E2E encryption.

### 2.1 Daemon — Child-Process Supervisor (2 weeks)

**Create**:
- `src/daemon/daemon.ts` — main daemon process entry point
- `src/daemon/child-process-supervisor.ts` — manages CLI children via ProcessManager
- `src/daemon/lock-file.ts` — `O_CREAT | O_EXCL` atomic locking
- `src/daemon/state-file.ts` — PID, port, heartbeat, version
- `src/daemon/control-api.ts` — HTTP on 127.0.0.1:0
- `src/daemon/health-check.ts` — 60s heartbeat loop
- `src/daemon/signal-handler.ts` — graceful shutdown

**Reusable code (~50%)**:
- `CLILauncher` (now `SdkUrlLauncher`) — session lifecycle, PID tracking, crash recovery
- `SessionManager` — auto-relaunch, reconnect, idle reaping
- `FileStorage` — atomic writes, WAL pattern for state persistence
- `ProcessManager` interface — spawn, kill, isAlive

**New code**:
- Lock file: `~/.beamcode/daemon.lock` with `O_CREAT | O_EXCL`, stale lock detection (check PID alive), auto-cleanup on exit
- State file: `~/.beamcode/daemon.state.json` — written atomically via FileStorage
- HTTP control API endpoints:
  - `GET /sessions` — list active sessions
  - `POST /sessions` — create new session (returns session ID)
  - `DELETE /sessions/:id` — stop session
  - `POST /revoke-device` — revoke paired device (Phase 2 E2E)
  - `GET /health` — daemon health status
- Signal handling: SIGTERM/SIGINT → graceful child process cleanup → exit
- Health check: update heartbeat in state file every 60s; external tools detect stale daemon by checking heartbeat age

**Tests**: Unit tests for lock file (acquire, detect stale, cleanup). Integration test: start daemon, create session, stop session, verify child process cleanup. Signal handling test: send SIGTERM, verify children stopped.

### 2.2 Relay — Cloudflare Tunnel Integration (1.5-2 weeks)

**Create**:
- `src/relay/tunnel-relay-adapter.ts` — manages cloudflared sidecar
- `src/relay/cloudflared-manager.ts` — spawn/monitor cloudflared process
- `src/relay/session-router.ts` — route by session ID from tunnel path

**Architecture**:
- `cloudflared` runs as a sidecar child process
- Reverse proxy: incoming HTTPS → localhost:PORT (daemon's WS server)
- Session routing uses existing `/ws/consumer/:sessionId` path convention
- Reconnection: exponential backoff (1s, 2s, 4s, 8s, max 30s), fast retry on network change detection

**Configuration**:
```typescript
interface TunnelConfig {
  mode: "development" | "production";
  // development: trycloudflare.com (free, ephemeral)
  // production: requires CF account + tunnel token
  tunnelToken?: string;
  metricsPort?: number;
}
```

**Tests**: Mock cloudflared process to test lifecycle management. Integration test with trycloudflare.com (can be slow, mark as `@slow`).

### 2.3 E2E Encryption (2-2.5 weeks)

**Create**:
- `src/utils/crypto/sealed-box.ts` — libsodium sealed boxes (XSalsa20-Poly1305)
- `src/utils/crypto/key-manager.ts` — keypair generation, sodium_malloc, mlock
- `src/utils/crypto/pairing.ts` — pairing link generation/consumption
- `src/utils/crypto/hmac-signing.ts` — HMAC-SHA256 permission signing
- `src/utils/crypto/encrypted-envelope.ts` — `{ v, sid, ct, len }` wire format
- `src/relay/encryption-layer.ts` — middleware: encrypt outbound, decrypt inbound

**Dependencies**: `libsodium-wrappers-sumo` (npm)

**Pairing link flow**:
1. Daemon generates X25519 keypair, stores secret key in `sodium_malloc` (mlock'd)
2. Daemon starts tunnel, gets tunnel URL
3. Daemon prints pairing link: `https://{tunnel}/pair?pk={base64url(publicKey)}&fp={fingerprint}&v=1`
4. Link expires in 60 seconds
5. Mobile browser opens link, extracts daemon public key
6. Browser generates own X25519 keypair
7. Browser sends own public key to daemon (sealed box with daemon's pk)
8. Both sides derive shared secrets for crypto_box (authenticated E2E)

**Permission response signing**:
- HMAC-SHA256 input: `request_id + behavior + timestamp + nonce`
- Nonce: random 16 bytes, daemon tracks last 1000 nonces (bounded by 30s timestamp window)
- Reject: duplicate nonce OR timestamp > 30s old OR unknown request_id

**EncryptedEnvelope**:
```typescript
interface EncryptedEnvelope {
  v: 1;              // Protocol version
  sid: string;       // Session ID (plaintext, for routing)
  ct: string;        // Base64url ciphertext
  len: number;       // Original plaintext length
}
```

**Tests**: Encrypt/decrypt roundtrip. Replay protection (duplicate nonce rejected, expired timestamp rejected). Pairing flow end-to-end with mock tunnel. Crypto overhead benchmark: must be < 5ms per message (abort trigger #5).

### 2.4 Reconnection Protocol (1-1.5 weeks)

**Create**:
- `src/server/consumer-channel.ts` — per-consumer send queue with backpressure
- `src/server/reconnection-handler.ts` — stable consumer IDs, seq tracking, replay
- `src/core/types/sequenced-message.ts` — `SequencedMessage<T>` wrapper

**Stable consumer IDs**: Assign UUID on first connect, store in browser localStorage. On reconnect, send `{ type: "reconnect", consumer_id, session_id, last_seen_seq }`.

**Message sequencing**: `SequencedMessage<T>` wraps any message at the serialization boundary (not baked into UnifiedMessage):
```typescript
interface SequencedMessage<T> {
  seq: number;
  message_id: string;
  timestamp: number;
  payload: T;           // ConsumerMessage or EncryptedEnvelope
}
```

**Per-consumer backpressure**:
- Send queue per consumer with configurable high-water mark (default: 1000 messages)
- When queue exceeds high-water: drop non-critical messages (`stream_event`), keep critical (`permission_request`, `result`)
- If queue overflows (> 5000) → disconnect consumer with error

**Message history pagination**: Store last 500 messages per session. On reconnect, replay from `last_seen_seq`. On initial connect, send last 20 messages. Virtual scrolling: consumer requests previous page.

**Tests**: Reconnection scenario: send messages, disconnect, reconnect with last_seen_seq, verify replay. Backpressure: slow consumer, verify queue management. Pagination: scroll back through history.

### 2.5 Minimal Web Consumer (1-1.5 weeks)

**Create**:
- `src/consumer/index.html` — single-page HTML/JS app
- `src/consumer/consumer-client.ts` — WebSocket client with reconnection
- `src/consumer/crypto-client.ts` — browser-side E2E decryption (Web Crypto API)
- `src/consumer/renderer.ts` — message rendering (markdown → HTML)
- `src/consumer/permission-ui.ts` — permission request/response UI

**Scope**: 500-1000 LOC total. Minimal viable interface for human testing:
- Connect to tunnel WebSocket
- Complete pairing handshake
- Decrypt incoming EncryptedEnvelopes
- Render assistant messages (basic markdown)
- Text input for user messages
- Permission request approval/denial buttons
- Reconnection indicator
- Session selector (if multiple sessions)

**No framework**: Vanilla HTML/JS/CSS. No React, no build step for the consumer.

**Tests**: Manual testing checklist (not automated for MVP consumer). Cypress or Playwright E2E test as stretch.

### 2.6 Phase 2.5: ACP Research (3-5 days, overlaps with weeks 7-8)

**Create**: `docs/research/acp-research-notes.md`

Read-only research (no code changes):
- Read the ACP specification
- Prototype throwaway JSON-RPC client
- Test against Goose's ACP server (if available)
- Document: message mapping (ACP → UnifiedMessage), capability gaps, PTY sidecar needs
- Identify any BackendAdapter interface changes needed for ACP

**Deliverable**: Research notes with confidence assessment for Phase 3 ACP adapter timeline.

### 2.7 Phase 2 Deliverables Checklist

- [ ] Daemon starts, acquires lock, manages child CLI processes
- [ ] HTTP control API: list/create/stop sessions, revoke-device, health
- [ ] cloudflared sidecar spawns, establishes tunnel, proxies to daemon
- [ ] E2E encryption: sealed boxes, pairing link, encrypted envelope
- [ ] Permission signing: HMAC-SHA256 with replay protection
- [ ] Session revocation: revoke-device generates new keypair
- [ ] Reconnection: stable consumer IDs, seq tracking, message replay
- [ ] Per-consumer backpressure with configurable high-water mark
- [ ] Per-consumer rate limiting: 10 msg/s, 100 KB/s
- [ ] Minimal web consumer: connect, pair, decrypt, render, input, permissions
- [ ] ACP research notes with Phase 3 confidence assessment
- [ ] Crypto overhead < 5ms/msg (abort trigger #5)
- [ ] Same-region RTT < 200ms through tunnel (abort trigger #6)
- [ ] Full integration test: mobile browser → tunnel → daemon → Claude Code → response

**Abort triggers checked**:
- #5: Crypto overhead > 5ms → implementation wrong
- #6: Same-region RTT > 200ms → architecture wrong
- #7: Cross-region RTT > 500ms → investigate

---

## Phase 3: Extract Library + ACP + Codex Adapters (4-6 weeks)

**Goal**: Extract reusable library core and validate it against two fundamentally different protocols.

### 3.1 Library Extraction (1-2 weeks)

**Restructure**: Move protocol-agnostic code into clean library API:
- `src/core/` — SessionBridge, UnifiedMessage, BackendAdapter (already done in Phase 1)
- Clean public API surface: `import { SessionBridge, BackendAdapter, UnifiedMessage } from "beamcode"`
- Document extension points for third-party adapters
- Publish `beamcode@0.2.0` to npm

**Contract test suite**: Formal test harness that any adapter must pass:
```typescript
function testBackendAdapterCompliance(adapter: BackendAdapter) {
  // Tests: connect, send, receive, close, capabilities
  // Tests: error handling, timeout behavior
  // Tests: concurrent sessions
}
```

### 3.2 ACP Adapter (2-3 weeks)

**Create**:
- `src/adapters/acp/acp-adapter.ts` — implements BackendAdapter
- `src/adapters/acp/acp-session.ts` — implements BackendSession
- `src/adapters/acp/json-rpc-client.ts` — JSON-RPC 2.0 over stdio
- `src/adapters/acp/capability-negotiator.ts` — ACP capability exchange
- `src/adapters/acp/pty-sidecar.ts` — PTY bridge for slash commands

**Protocol**: JSON-RPC 2.0 over stdio (spawn ACP-compatible CLI, communicate via stdin/stdout)

**Message mapping**: ACP JSON-RPC → UnifiedMessage (request/response model, not streaming)

**PTY sidecar**: For features ACP doesn't expose (slash commands), spawn a PTY session alongside the ACP session. Route slash commands through PTY, everything else through ACP.

**Important**: The ACP adapter should be implemented by a different developer than the relay developer (Oracle's recommendation). This is the "library customer" test — if someone unfamiliar with the relay internals can build an adapter using only the documented interfaces, the library is good.

**Success/failure signals**:
- SUCCESS: ACP adapter < 500 LOC beyond the adapter itself
- FAILURE: ACP adapter > 1000 LOC AND requires UnifiedMessage type changes

### 3.3 Codex CLI Adapter (3-5 days)

**Create**:
- `src/adapters/codex/codex-adapter.ts` — implements BackendAdapter
- `src/adapters/codex/codex-session.ts` — implements BackendSession
- `src/adapters/codex/codex-message-translator.ts` — Thread/Turn/Item → UnifiedMessage
- `src/adapters/codex/codex-launcher.ts` — spawn `codex app-server --listen ws://host:port`

**Protocol**: Modified JSON-RPC 2.0 over WebSocket

**Initialization**: `initialize` → response → `initialized` handshake before session start

**Message model**: Codex uses Thread/Turn/Item hierarchy:
- Thread = conversation session
- Turn = user/assistant exchange
- Item = individual content piece (text, tool call, tool result)

Map to UnifiedMessage: Thread → session, Turn → message group (parentId), Item → content block

**Approval flow**: Codex command/file approvals → bridge permission requests → user response → Codex approval/denial

**Why Codex validates the library**: Same transport as SdkUrl (WebSocket) but fundamentally different message model (Thread/Turn/Item JSON-RPC vs flat NDJSON events). With SdkUrl + ACP + Codex, BackendAdapter is tested across all 4 transport x protocol combinations:
| | WebSocket | stdio |
|---|---|---|
| NDJSON | SdkUrl | — |
| JSON-RPC | Codex | ACP |

### 3.4 Phase 3 Deliverables Checklist

- [ ] Clean library API published as `beamcode@0.2.0`
- [ ] Contract test suite for BackendAdapter compliance
- [ ] ACP adapter: JSON-RPC/stdio, capability negotiation, PTY sidecar
- [ ] ACP adapter < 500 LOC (success signal)
- [ ] Codex adapter: JSON-RPC/WS, Thread/Turn/Item translation
- [ ] Codex adapter: initialization handshake, approval flow mapping
- [ ] All 3 adapters pass BackendAdapter contract test suite
- [ ] UnifiedMessage changed ≤ 2 times during Phase 3 (abort trigger #4)

**Abort trigger**: UnifiedMessage changes > 2 times → type too SdkUrl-specific, stop and redesign.

---

## Phase 4: AgentSdk Adapter (stretch, 2-3 weeks)

**Only if Phase 3 completes on time.** 50% success probability.

**Create**:
- `src/adapters/agent-sdk/agent-sdk-adapter.ts`
- `src/adapters/agent-sdk/permission-bridge.ts` — Promise-to-broadcast pattern

**Challenge**: AgentSdk uses Promise-based permission handling (resolve/reject), while the bridge uses broadcast-based (send request, wait for any consumer to respond). Bridging these models cleanly is the key risk.

**Abort trigger**: Permission coordination > 500 LOC → too complex, defer.

---

## Cross-Cutting Concerns

### Testing Strategy

| Phase | Test Type | Target |
|---|---|---|
| Phase 0 | Unit + property-based | UnifiedMessage serialization, interface compliance |
| Phase 1 | Unit + integration | Message translation roundtrips, SessionBridge refactor (417+ tests pass) |
| Phase 2 | Unit + integration + E2E | Daemon lifecycle, crypto, reconnection, tunnel RTT benchmarks |
| Phase 3 | Contract + integration | Adapter compliance suite, cross-adapter message fidelity |
| All | CI | `vitest run` on every commit, coverage ≥ 80% |

### Dependency Management

| Dependency | Phase | Purpose |
|---|---|---|
| `libsodium-wrappers-sumo` | Phase 2 | E2E encryption (sealed boxes, crypto_box) |
| `cloudflared` (binary) | Phase 2 | Tunnel sidecar (not npm — system binary) |
| None (vanilla) | Phase 2 | Web consumer (no framework) |

### Configuration

All config stored in `~/.beamcode/`:
- `daemon.lock` — lock file
- `daemon.state.json` — daemon state (PID, port, heartbeat)
- `sessions/` — per-session state files (via FileStorage)
- `keys/` — keypair storage (daemon private key, paired device public keys)

### Error Handling Principles

- Adapters must NOT throw on individual message failures — log and continue
- Daemon must NOT crash on individual session failures — isolate and report
- E2E decryption failure on a single message: log, skip, continue (don't tear down session)
- Tunnel disconnection: exponential backoff reconnect, don't stop daemon
- CLI crash: auto-restart via SessionManager (existing behavior)

---

## Risk Mitigations

| Risk | Probability | Mitigation |
|---|---|---|
| Phase 2 scope explosion | HIGH | Hard timebox 7 weeks. Cut E2E to transport-only if needed. |
| Extraction gamble (relay-biased abstractions) | MEDIUM | ACP + Codex validate universality. < 500 LOC success signal. |
| Codex WS mode experimental | MEDIUM | stdio JSONL fallback. Adapter supports both transports. |
| CF free tier changes | MEDIUM | trycloudflare.com for dev only. Production requires CF account. |
| E2E crypto bug | LOW | Use libsodium (audited). No custom crypto. Test suite with known vectors. |

---

## Milestone Summary

| Week | Milestone | Key Deliverable |
|---|---|---|
| 2 | Phase 0 complete | UnifiedMessage, BackendAdapter, security quick wins |
| 5-6 | Phase 1 complete | SdkUrlAdapter, SessionBridge refactored |
| 7-8 | Daemon working | Child-process supervisor, HTTP control API |
| 9-10 | Tunnel + E2E working | cloudflared integration, sealed boxes, pairing link |
| 11-12 | Reconnection + consumer | Stable consumer IDs, message replay, web client |
| 13-14 | Phase 2 complete | Full relay MVP: mobile → tunnel → daemon → Claude Code |
| 15-16 | ACP adapter | JSON-RPC/stdio, library validation |
| 17 | Codex adapter | JSON-RPC/WS, 3-adapter validation matrix |
| 18-19 | Phase 3 complete | Library extracted, npm v0.2.0 published |
| 20-22 | Phase 4 (stretch) | AgentSdk adapter (if on schedule) |
