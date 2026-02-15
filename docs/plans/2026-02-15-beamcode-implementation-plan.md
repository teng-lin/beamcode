# BeamCode Implementation Plan

**Date**: 2026-02-15 (revised 2026-02-15 post-review)
**Based on**: `docs/architecture/decisions.md` v2.1, `docs/architecture/architecture-diagram.md`
**Approach**: 1 engineer, sequential phases, relay-first MVP
**Total timeline**: 21-26 weeks (likely 23 weeks)
**Review**: See `2026-02-15-implementation-plan-review.md` for full expert panel findings

---

## Current State

The codebase (forked from `claude-code-bridge`) contains a working SdkUrl-only bridge:

- **SessionBridge** (`src/core/session-bridge.ts`, ~1,283 LOC) — monolithic bridge handling CLI↔consumer message routing, session state, permissions, message history, rate limiting
- **CLILauncher** (`src/core/cli-launcher.ts`, ~548 LOC) — process lifecycle, PID tracking, crash recovery, kill escalation (~350 LOC SdkUrl-specific, ~200 LOC generic process management)
- **SessionManager** (`src/core/session-manager.ts`, ~340 LOC) — multi-session orchestration, auto-relaunch, reconnect, idle reaping. Directly wires SessionBridge + CLILauncher; must change when either changes.
- **FileStorage** (`src/adapters/file-storage.ts`, ~213 LOC) — atomic writes with WAL pattern, UUID validation (genuinely reusable as-is)
- **NodeWebSocketServer** (`src/adapters/node-ws-server.ts`, ~124 LOC) — local WS server
- **Types** — `CLIMessage` (SdkUrl NDJSON, 10 types), `ConsumerMessage` (19 variants, **directly imports CLIMessage types**), `InboundMessage`, `SessionState` (30 fields)
- **Utilities** — NDJSON parser, ANSI strip, token bucket rate limiter, sliding window breaker
- **417 tests passing** across 12 test files (largest: `session-bridge.test.ts` at 3,030 LOC)

The bridge currently only speaks SdkUrl (NDJSON/WebSocket via `--sdk-url`). All CLI-specific logic is tightly coupled into `SessionBridge.routeCLIMessage()` (10-case switch at lines 730-766, dispatching to handler methods spanning lines 768-1013, ~283 LOC total) and `SessionBridge.routeConsumerMessage()`.

**Key coupling identified by review panel**:
- `ConsumerMessage` imports `CLIAssistantMessage["message"]` and `CLIResultMessage` from `cli-messages.ts` — must be decoupled for adapter-agnostic bridge
- Handler methods mutate `session.state` directly (19 field assignments across 4 methods) — prevents "pure function" translator without state extraction
- `SessionManager` imports both `SessionBridge` and `CLILauncher` concretely, wiring 26 event forwarding statements

---

## Phase 0: Foundation (2.5 weeks)

**Goal**: Design the universal type system and adapter interfaces that all subsequent phases build on. This is "Decision 0" — it blocks everything.

### 0.1 UnifiedMessage Type (5-6 days)

**Create**: `src/core/types/unified-message.ts`

Design a normalized message format that works across:
- SdkUrl: streaming NDJSON (assistant chunks, stream events, results)
- ACP: JSON-RPC request/response (synchronous tool calls, capability negotiation)
- Codex: Thread/Turn/Item model (conversation hierarchy, approval flows)

```typescript
interface UnifiedMessage {
  id: string;                           // Unique message ID (UUID)
  timestamp: number;                    // Unix ms
  type: UnifiedMessageType;             // Normalized type enum
  role: "user" | "assistant" | "system" | "tool";
  content: UnifiedContent[];            // Content blocks (primary for assistant messages)
  metadata: Record<string, unknown>;    // Adapter-specific data (primary for most other types)
  parentId?: string;                    // For threading (Codex Turn→Thread)
}
```

**Design philosophy — envelope-centric, not content-centric**: Review panel analysis shows that only `assistant` messages map cleanly to content blocks. The other 9 of 10 CLIMessage types (system/init, system/status, result, stream_event, control_request, control_response, tool_progress, tool_use_summary, auth_status) will primarily use the `metadata` field. This is architecturally correct — `UnifiedMessage` is a thin envelope with a `type` discriminator. Treat `metadata` as the normal path, `content` as a specialization for chat-model messages.

**Key design constraints**:
- Message IDs from day one (not bolted on later)
- **No `seq` field** — sequencing is a transport concern handled by `SequencedMessage<T>` wrapper in Phase 2.4
- Content blocks must support text, tool_use, tool_result, code, images
- Metadata field is the primary data carrier for non-chat message types — not an "escape hatch"
- Unknown message types pass through (forward-compatible)
- Investigate deterministic JSON serialization (e.g., `json-canonicalize` or explicit key ordering) — needed for HMAC signing in Phase 2.3. Budget 1 day for investigation and decision.

**Tests**: Property-based tests for serialization roundtrip. Contract tests asserting SdkUrl CLIMessage → UnifiedMessage → ConsumerMessage lossless conversion. Deterministic serialization tests if canonical JSON is adopted.

**Abort trigger**: If SdkUrl and ACP message models can't be unified without > 30% information loss (measured as: fields that cannot be recovered from either `content` or `metadata`), stop and reconsider.

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

**Note**: Avoid naming collision with existing `InitializeCapabilities` (session-state.ts) — the existing type refers to CLI commands/models/account, not protocol capabilities. Use `BackendCapabilities` consistently.

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
   - Token registry interface bridges CLILauncher (generates) → SessionManager → NodeWebSocketServer (validates)
   - Token stored in session state, not in filesystem

3. **Fix RateLimiter interface mismatch** (0.5 days):
   - Update `RateLimiter` interface: `tryConsume(tokens?: number): boolean` to match `TokenBucketLimiter.tryConsume(tokensNeeded = 1)` implementation
   - Required for byte-rate limiting in Phase 2 (pass message byte count as tokens)

**Tests**: Unit tests for origin validation logic. Integration test: CLI with wrong token rejected. RateLimiter interface compliance test.

### 0.4 Phase 0 Deliverables Checklist

- [ ] `UnifiedMessage` type — envelope-centric design, no `seq` field, with serialization tests
- [ ] Deterministic JSON serialization decision documented (canonical JSON vs key-ordering)
- [ ] `BackendAdapter` / `BackendSession` interfaces with contract test harness
- [ ] Extension interfaces: `Interruptible`, `Configurable`, `PermissionHandler`
- [ ] Relay extension interfaces (defined, not implemented): `Reconnectable`, `Encryptable`
- [ ] `BackendCapabilities` type with `availability` mode
- [ ] WebSocket origin validation
- [ ] CLI auth token generation and verification
- [ ] RateLimiter interface mismatch fixed
- [ ] All existing 417 tests still passing
- [ ] New types do NOT break existing SessionBridge (coexistence, not replacement)

---

## Phase 1: SdkUrl Adapter Extraction (5-7 weeks)

**Goal**: Extract SdkUrl-specific logic from SessionBridge into a clean `SdkUrlAdapter` that implements `BackendAdapter`. Split into Phase 1a (low-risk skeleton) and Phase 1b (high-risk rewire).

### Phase 1a: Adapter Skeleton (1.5-2 weeks)

Validates the adapter design cheaply before committing to the expensive bridge refactor.

#### 1a.1 Extract Message Translator (1 week)

**Modify**: `src/core/session-bridge.ts`
**Create**: `src/adapters/sdk-url/sdk-url-adapter.ts`, `src/adapters/sdk-url/message-translator.ts`, `src/adapters/sdk-url/state-reducer.ts`

SessionBridge currently has a 10-case `routeCLIMessage()` switch (lines 730-766) dispatching to handler methods (~283 LOC, lines 768-1013). Extract into:

1. `SdkUrlMessageTranslator`: CLIMessage → UnifiedMessage translation logic
2. `SdkUrlStateReducer`: Extracted state mutations (19 field assignments from 4 handler methods) — `handleSystemMessage` (11 fields), `handleResultMessage` (8 fields), `handleControlRequest` (pendingPermissions), `handleControlResponse` (capabilities)
3. `SdkUrlAdapter.send()`: UnifiedMessage → NDJSON string → CLI WebSocket
4. `SdkUrlAdapter.messages`: CLI WebSocket → NDJSON parse → UnifiedMessage (AsyncIterable)

**Important**: The translator and state reducer are separate concerns. The translator produces `UnifiedMessage`; the state reducer applies side effects to `SessionState`. SessionBridge orchestrates: translator → state reducer → persistence → broadcast.

**Message mapping** (CLIMessage → UnifiedMessage):
| CLIMessage type | UnifiedMessage type | Content vs Metadata |
|---|---|---|
| `system/init` (19 fields) | `session_init` | Metadata-dominant: model, cwd, tools, etc. |
| `system/status` | `status_change` | Metadata: status enum |
| `assistant` | `assistant` | **Content blocks** (the one content-centric type) |
| `result` (18 fields) | `result` | Metadata-dominant: cost, turns, usage, duration |
| `stream_event` | `stream_event` | Metadata: opaque event passthrough |
| `control/request` | `permission_request` | Metadata: tool_name, input, suggestions |
| `control/response` | `control_response` | Metadata: initialize response |
| `tool_progress` | `tool_progress` | Metadata: tool_use_id, elapsed_time |
| `tool_use_summary` | `tool_use_summary` | Metadata: summary, tool_use_ids |
| `auth_status` | `auth_status` | Metadata: isAuthenticating, output, error |

**Tests**: For each CLIMessage type, test: CLIMessage → UnifiedMessage produces correct type/content/metadata. State reducer tests: verify field assignments match current handler behavior.

#### 1a.2 Extract CLILauncher → SdkUrlLauncher + ProcessSupervisor (3-4 days)

**Rename/Move**: `src/core/cli-launcher.ts` → `src/adapters/sdk-url/sdk-url-launcher.ts`
**Create**: `src/core/process-supervisor.ts`

CLILauncher has ~200 LOC of generic process management and ~350 LOC of SdkUrl-specific spawning logic. Extract:

1. **ProcessSupervisor** base class (~200 LOC): kill escalation with SIGTERM→SIGKILL (lines 423-448), circuit breaker integration (lines 63-75, 339-347, 379-381), PID tracking and restore (lines 93-122), output piping (lines 517-547). The daemon reuses this in Phase 2.
2. **SdkUrlLauncher** extends ProcessSupervisor: `--sdk-url`, `--resume`, `--print`, `--output-format stream-json`, `--permission-mode` argument construction.

**Changes**:
- Rename class: `CLILauncher` → `SdkUrlLauncher`
- Extract `ProcessSupervisor` base class
- `SdkUrlAdapter.connect()` uses `SdkUrlLauncher` internally
- Update imports in 4 files: test file, `core/index.ts`, `session-manager.ts`, `src/index.ts`

### Phase 1b: Bridge Rewire (3.5-5 weeks)

The high-risk phase. Changes SessionBridge internals and rewrites tests.

#### 1b.1 Redesign ConsumerMessage (3-5 days)

**Modify**: `src/types/consumer-messages.ts`

Currently `ConsumerMessage` directly imports `CLIAssistantMessage["message"]` and `CLIResultMessage` from `cli-messages.ts`. This hard-couples the consumer-facing API to SdkUrl types.

Redesign `ConsumerMessage` to be defined in terms of `UnifiedMessage` or its own normalized types:
- Replace `CLIAssistantMessage["message"]` with a normalized `AssistantContent` type
- Replace `CLIResultMessage` embedding with a `ResultData` type using only `CoreSessionState` fields + metadata
- Distinguish bridge-internal consumer messages (`cli_disconnected`, `cli_connected`, `presence_update`, `message_history`) from protocol messages — only the latter relate to UnifiedMessage

#### 1b.2 Generalize SessionState + Event Names (5-7 days)

**Modify**: `src/types/session-state.ts`, `src/types/events.ts`
**Create**: `src/core/types/core-session-state.ts`

Split current `SessionState` (30 fields) into:
- `CoreSessionState`: session_id, status, created_at, last_activity (adapter-agnostic)
- `SdkUrlSessionState extends CoreSessionState`: model, cwd, tools, permissionMode, etc.

**State split decision** (informed by review):
- Universal: `session_id`, `total_cost_usd`, `num_turns`, `context_used_percent`, `is_compacting`
- Development-tool-specific: `git_branch`, `is_worktree`, `repo_root`, `git_ahead`, `git_behind`, `total_lines_added`, `total_lines_removed`
- SdkUrl-specific: `model`, `cwd`, `tools`, `permissionMode`, `claude_code_version`, `mcp_servers`, `agents`, `slash_commands`, `skills`, `last_model_usage`, `last_duration_ms`, `last_duration_api_ms`, `capabilities`

**Note**: `SlashCommandExecutor` depends on 15+ SdkUrl-specific fields. It stays coupled to `SdkUrlSessionState` and moves to `src/adapters/sdk-url/` directory.

**Event name migration**:
- `cli:connected` → `backend:connected`
- `cli:disconnected` → `backend:disconnected`
- `cli:message` → `backend:message`
- Dual-emission during Phase 1b: emit both old and new names. Remove old names in Phase 2.
- Touches `BridgeEventMap` (18 event types), `LauncherEventMap` (7 event types), `SessionManager.wireEvents()` (26 wiring statements)

#### 1b.3 InboundMessage Translation (2-3 days)

**Create**: `src/adapters/sdk-url/inbound-translator.ts`

The plan originally covered CLIMessage→UnifiedMessage but not the reverse: consumer messages arriving at the bridge must be translated to the format the CLI expects. Currently `routeConsumerMessage` constructs NDJSON strings directly via `serializeNDJSON` and `JSON.stringify`.

Create `SdkUrlInboundTranslator`: UnifiedMessage → NDJSON string for the CLI.

#### 1b.4 Update SessionManager (2-3 days)

**Modify**: `src/core/session-manager.ts`

SessionManager directly imports and wires `SessionBridge` + `CLILauncher`. After Phase 1a/1b changes:
- Update imports: `CLILauncher` → `SdkUrlLauncher`
- Update construction: SessionBridge now takes `BackendAdapter`
- Update event wiring: 26 statements use old event names → migrate to `backend:*`
- Reusable patterns to preserve: reconnect watchdog (~17 LOC), idle reaper (~40 LOC), stop/start lifecycle (~35 LOC)

#### 1b.5 Rewire SessionBridge (2 weeks)

**Modify**: `src/core/session-bridge.ts`

Refactor SessionBridge to consume `BackendAdapter` instead of directly handling CLI WebSockets. Following Oracle's recommendation, this is done in two steps:

**Step 1 — Coexistence mode (1 week)**: Introduce `BackendAdapter` as a parallel path alongside the existing raw CLI handling. Both paths active. New adapter path tested independently. Old path continues to serve existing tests.

**Step 2 — Remove old path (1 week)**: Once new path passes all tests, remove direct CLI WebSocket handling, NDJSON parsing, and `sendToCLI()`.

```typescript
class SessionBridge {
  constructor(options: {
    adapter: BackendAdapter;  // NEW: replaces direct CLI socket handling
    // ... existing options (storage, logger, metrics, etc.)
  }) {}
}
```

**Changes**:
- Remove `session.cliSocket: WebSocketLike | null` — replace with `BackendSession`
- Remove `handleCLIOpen()`, `handleCLIMessage()`, `handleCLIClose()` — internal to `SdkUrlAdapter`
- Remove `sendToCLI()` — replaced by `BackendSession.send(UnifiedMessage)`
- Convert `pendingMessages` from `string[]` to `UnifiedMessage[]`
- Add `PersistedSession` format migration: detect old NDJSON string format on restore, convert to `UnifiedMessage[]`
- Consumer side unchanged in Phase 1 — bridge remains asymmetric (abstract adapter on backend, raw WebSockets on consumer)

**Critical invariant**: All 417 existing tests must pass after this refactor.

#### 1b.6 Test Rewrite (1-2 weeks)

**Modify**: `src/core/session-bridge.test.ts` (3,030 LOC)

This is the largest single file in the project. Every test constructs NDJSON strings and feeds them through `handleCLIMessage()`. After the refactor, this interface disappears.

**Strategy**:
- Tests that simulate CLI messages → rewrite to either mock `BackendAdapter`/`BackendSession` OR use `SdkUrlAdapter` as integration layer
- Tests that assert `ConsumerMessage` output → update assertions for redesigned `ConsumerMessage` types
- Tests that check event names → update to `backend:*` event names
- Target: same behavioral coverage, different internal wiring

This is a structural rewrite, not a search-and-replace.

#### 1b.7 BackendAdapter Documentation (1-2 days)

**Create**: `docs/adapters/backend-adapter-guide.md`

Write adapter implementor documentation during Phase 1 (not Phase 3 as originally planned). The contract test harness from Phase 0.2 defines the interface semantics — convert test descriptions into API documentation while the extraction is fresh. This enables the Phase 3 requirement that the ACP adapter be implemented by someone other than the relay developer.

### 1.8 Phase 1 Deliverables Checklist

- [ ] `SdkUrlAdapter` implements `BackendAdapter` interface
- [ ] `SdkUrlLauncher` (renamed from CLILauncher) in `src/adapters/sdk-url/`
- [ ] `ProcessSupervisor` base class extracted for daemon reuse
- [ ] `SdkUrlMessageTranslator` with CLIMessage→UnifiedMessage translation
- [ ] `SdkUrlStateReducer` with extracted state mutations
- [ ] `SdkUrlInboundTranslator` with UnifiedMessage→NDJSON reverse path
- [ ] `ConsumerMessage` redesigned — decoupled from CLIMessage types
- [ ] `CoreSessionState` separated from `SdkUrlSessionState`
- [ ] `SlashCommandExecutor` moved to `src/adapters/sdk-url/`
- [ ] Generalized event names (`backend:*`) with old names removed
- [ ] `SessionManager` updated for new imports and event wiring
- [ ] `PersistedSession` format migration (old NDJSON → UnifiedMessage)
- [ ] SessionBridge consumes `BackendAdapter`, not raw CLIMessage
- [ ] All 417+ tests passing (target: 500+ with new adapter contract tests)
- [ ] Test rewrite complete for `session-bridge.test.ts`
- [ ] Contract test: `SdkUrlAdapter` passes `BackendAdapter` compliance suite
- [ ] `BackendAdapter` implementor documentation written

**Abort trigger**: Phase 1 takes > 5 weeks → the abstraction is wrong, stop and redesign. (Previous trigger of > 3 weeks fell within the plan's own confidence interval.)

---

## Phase 2: Relay MVP (8-9 weeks, including 1 week contingency)

**Goal**: Build the core product differentiator — mobile browser access to running Claude Code sessions via Cloudflare Tunnel with E2E encryption.

### 2.1 Daemon — Child-Process Supervisor (2-2.5 weeks)

**Create**:
- `src/daemon/daemon.ts` — main daemon process entry point
- `src/daemon/child-process-supervisor.ts` — manages CLI children via ProcessSupervisor base class
- `src/daemon/lock-file.ts` — `O_CREAT | O_EXCL` atomic locking
- `src/daemon/state-file.ts` — PID, port, heartbeat, version
- `src/daemon/control-api.ts` — HTTP on 127.0.0.1:0 with bearer token auth
- `src/daemon/health-check.ts` — 60s heartbeat loop
- `src/daemon/signal-handler.ts` — graceful shutdown

**Reusable code (~39%)**: Based on detailed review analysis:
- `ProcessSupervisor` base class (~200 LOC from CLILauncher) — kill escalation, circuit breaker, PID tracking
- `SessionManager` patterns (~92 LOC) — reconnect watchdog, idle reaper, stop/start lifecycle
- `FileStorage` (213 LOC) — atomic writes, WAL pattern (genuinely reusable as-is)
- `ProcessManager` interface (22 LOC) — spawn, isAlive

Total reusable: ~527 LOC. New daemon code: ~830 LOC. Total: ~1,357 LOC.

**New code**:
- Lock file: `~/.beamcode/daemon.lock` with `O_CREAT | O_EXCL`, stale lock detection (check PID alive), auto-cleanup on exit
- State file: `~/.beamcode/daemon.state.json` — written atomically via FileStorage, includes control API bearer token
- HTTP control API endpoints (with bearer token authentication):
  - `GET /sessions` — list active sessions
  - `POST /sessions` — create new session (returns session ID)
  - `DELETE /sessions/:id` — stop session
  - `POST /revoke-device` — revoke paired device (Phase 2 E2E)
  - `GET /health` — daemon health status
  - Authentication: random bearer token generated on daemon start, stored in `daemon.state.json`. Require `Authorization: Bearer {token}` on all requests. Alternative: Unix domain socket with `0700` permissions.
- Signal handling: SIGTERM/SIGINT → graceful child process cleanup → exit
- Health check: update heartbeat in state file every 60s; external tools detect stale daemon by checking heartbeat age

**Milestone**: Daemon working without tunnel at ~week 10. Independently useful as a session supervisor for local multi-session management. Fallback ship target if tunnel integration encounters blockers.

**Tests**: Unit tests for lock file (acquire, detect stale, cleanup). Integration test: start daemon, create session, stop session, verify child process cleanup. Signal handling test: send SIGTERM, verify children stopped. **Control API tests**: request validation, error responses, authentication (reject missing/invalid token), concurrent requests.

### 2.2 Relay — Cloudflare Tunnel Integration (1.5-2 weeks)

**Create**:
- `src/relay/tunnel-relay-adapter.ts` — manages cloudflared sidecar
- `src/relay/cloudflared-manager.ts` — spawn/monitor cloudflared process
- `src/relay/session-router.ts` — route by session ID from tunnel path

**Cloudflared smoke test (day 1)**: Before building the full adapter, verify that `trycloudflare.com` tunnels work for WebSocket traffic with the existing `NodeWebSocketServer` unmodified. If this fails, the relay architecture needs rethinking and it's better to discover on day 1 than day 10.

**Cloudflared availability detection**: Graceful error when `cloudflared` is not installed, with installation instructions for each platform (Homebrew on macOS, apt on Linux, direct download). Budget 0.5 days.

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

### 2.3 E2E Encryption (2.5 weeks, hard timebox)

**Create**:
- `src/utils/crypto/sealed-box.ts` — libsodium sealed boxes (pairing handshake only)
- `src/utils/crypto/crypto-box.ts` — libsodium crypto_box (all post-pairing messages)
- `src/utils/crypto/key-manager.ts` — keypair generation, sodium_malloc, mlock
- `src/utils/crypto/pairing.ts` — pairing link generation/consumption with server-side enforcement
- `src/utils/crypto/hmac-signing.ts` — HMAC-SHA256 permission signing with updatedInput
- `src/utils/crypto/encrypted-envelope.ts` — `{ v, sid, ct }` wire format (no `len`)
- `src/relay/encryption-layer.ts` — middleware: encrypt outbound, decrypt inbound

**Dependencies**:
- `sodium-native` (daemon/Node.js) — N-API bindings to C libsodium, real `mlock` for key protection. Pin exact version.
- `libsodium-wrappers-sumo` (browser consumer) — WASM build, no native compilation. Pin exact version (no caret).

Note: `sodium-native` requires native compilation (C compiler, node-gyp). Make it an optional peer dependency with fallback to `libsodium-wrappers-sumo` for environments without a C toolchain.

**Sealed box vs crypto_box delineation**:
- **Sealed boxes (`crypto_box_seal`)**: Used ONLY during pairing handshake, steps 5-7. Mobile sends its public key sealed with daemon's public key. Anonymous sender encryption — daemon cannot authenticate who sealed it.
- **crypto_box**: Used for ALL post-pairing messages. Authenticated bidirectional encryption using both keypairs. Provides sender authentication that sealed boxes lack.

**Pairing link flow**:
1. Daemon generates X25519 keypair, stores secret key in `sodium_malloc` (mlock'd)
2. Daemon starts tunnel, gets tunnel URL
3. Daemon prints pairing link: `https://{tunnel}/pair?pk={base64url(publicKey)}&fp={fingerprint}&v=1`
4. Link expires in 60 seconds — **enforced server-side**: daemon rejects pairing requests after 60 seconds AND after one successful pairing, invalidates endpoint entirely after either condition
5. Mobile browser opens link, extracts daemon public key
6. Browser generates own X25519 keypair
7. Browser sends own public key to daemon (**sealed box** with daemon's pk)
8. Both sides switch to **crypto_box** (authenticated E2E)

**Permission response signing**:
- HMAC-SHA256 input: `request_id + behavior + JSON.canonicalize(updatedInput) + timestamp + nonce`
- **`updatedInput` MUST be included** — without it, a relay-position attacker can modify the approved command while preserving a valid signature
- Uses deterministic JSON serialization (from Phase 0.1 investigation) for `updatedInput`
- Nonce: random 16 bytes, daemon tracks last 1000 nonces (bounded by 30s timestamp window)
- Reject: duplicate nonce OR timestamp > 30s old OR unknown request_id
- Two-layer trust model: HMAC is between daemon↔CLI (localhost); E2E encryption is between mobile↔daemon (tunnel). Mobile never sees the HMAC secret.

**EncryptedEnvelope**:
```typescript
interface EncryptedEnvelope {
  v: 1;              // Protocol version
  sid: string;       // Session ID (plaintext, for routing)
  ct: string;        // Base64url ciphertext
  // No `len` field — plaintext length derivable from ciphertext
  // length minus crypto overhead (crypto_box_MACBYTES = 16 bytes).
  // Exposing `len` enables traffic analysis.
}
```

**Hard timebox scope cut**: If pairing handshake is not working end-to-end by day 12, defer HMAC permission signing to post-MVP. Ship with E2E encryption only (no replay protection on permission responses). This loses a security property but preserves the timeline.

**Tests**: Encrypt/decrypt roundtrip. Replay protection (duplicate nonce rejected, expired timestamp rejected). Tampered updatedInput rejected. Pairing flow end-to-end with mock tunnel. Pairing expiry enforcement (server-side, reject after 60s, reject after one successful pairing). Crypto overhead benchmark: must be < 5ms per message (abort trigger #5). Plus Security Expert's 28-test matrix (see Cross-Cutting Concerns).

### 2.4 Reconnection Protocol (1-1.5 weeks)

**Create**:
- `src/server/consumer-channel.ts` — per-consumer send queue with backpressure
- `src/server/reconnection-handler.ts` — stable consumer IDs, seq tracking, replay
- `src/core/types/sequenced-message.ts` — `SequencedMessage<T>` wrapper

**Stable consumer IDs**: Assign UUID on first connect, store in browser localStorage. On reconnect, send `{ type: "reconnect", consumer_id, session_id, last_seen_seq }`.

**Message sequencing**: `SequencedMessage<T>` wraps any message at the serialization boundary (NOT baked into UnifiedMessage — sequencing is a transport concern):
```typescript
interface SequencedMessage<T> {
  seq: number;
  message_id: string;
  timestamp: number;
  payload: T;           // ConsumerMessage or EncryptedEnvelope
}
```

**Backpressure-encryption ordering**: Backpressure operates on **plaintext** (before encryption). This allows the backpressure layer to inspect message types for priority decisions (drop `stream_event`, keep `permission_request`). Encrypted messages are opaque and cannot be inspected.

**Per-consumer backpressure**:
- Send queue per consumer with configurable high-water mark (default: 1000 messages)
- When queue exceeds high-water: drop non-critical messages (`stream_event`), keep critical (`permission_request`, `result`)
- If queue overflows (> 5000) → disconnect consumer with error

**Message history pagination**: Store last 500 messages per session. On reconnect, replay from `last_seen_seq`. On initial connect, send last 20 messages. Virtual scrolling: consumer requests previous page.

**Tests**: Reconnection scenario: send messages, disconnect, reconnect with last_seen_seq, verify replay. Backpressure: slow consumer, verify queue management. Backpressure before encryption: verify priority decisions use plaintext type. Pagination: scroll back through history.

### 2.5 Minimal Web Consumer (1.5-2 weeks)

**Start early**: Begin the unencrypted consumer (WebSocket client, message renderer, text input) in parallel with E2E encryption work. The consumer's core UI does not depend on E2E. Add the encryption layer once Phase 2.3 completes.

**Create**:
- `src/consumer/index.html` — single-page HTML/JS app
- `src/consumer/consumer-client.ts` — WebSocket client with reconnection
- `src/consumer/crypto-client.ts` — browser-side E2E decryption (Web Crypto API with `extractable: false` for key storage)
- `src/consumer/renderer.ts` — message rendering (use a lightweight markdown library, not hand-rolled)
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

**No framework**: Vanilla HTML/JS/CSS. No React, no build step for the consumer. Use a CDN-hosted markdown library (e.g., `marked`) — hand-rolling markdown rendering is not worth the time.

**Tests**: Manual testing checklist (not automated for MVP consumer). Cypress or Playwright E2E test as stretch.

### 2.6 ACP Research (3-5 days, overlaps with late Phase 2)

**Create**: `docs/research/acp-research-notes.md`

Read-only research (no code changes):
- Read the ACP specification
- Prototype throwaway JSON-RPC client
- Test against Goose's ACP server (if available)
- Document: message mapping (ACP → UnifiedMessage), capability gaps, PTY sidecar needs
- Identify any BackendAdapter interface changes needed for ACP

**Deliverable**: Research notes with confidence assessment for Phase 3 ACP adapter timeline.

### 2.7 CI/CD Pipeline Updates (2-3 days)

**Modify**: CI configuration

- Add `sodium-native` / `libsodium-wrappers-sumo` to CI environment
- Create mock/stub for `cloudflared` binary in CI
- Define `@slow` test strategy: tunnel integration tests run in nightly CI, not on every commit
- npm publish automation for `beamcode@0.2.0`

### 2.8 Phase 2 Deliverables Checklist

- [ ] Daemon starts, acquires lock, manages child CLI processes
- [ ] HTTP control API with bearer token auth: list/create/stop sessions, revoke-device, health
- [ ] Daemon-without-tunnel milestone functional (fallback ship target)
- [ ] cloudflared availability detection with graceful error
- [ ] cloudflared smoke test passes (WebSocket through trycloudflare.com)
- [ ] cloudflared sidecar spawns, establishes tunnel, proxies to daemon
- [ ] E2E encryption: sealed boxes (pairing only) → crypto_box (post-pairing)
- [ ] Pairing link with server-side 60s expiry + one-time use enforcement
- [ ] Permission signing: HMAC-SHA256 with updatedInput + replay protection
- [ ] Session revocation: revoke-device generates new keypair, requires re-pairing
- [ ] Reconnection: stable consumer IDs, seq tracking, message replay
- [ ] Per-consumer backpressure operating on plaintext (before encryption)
- [ ] Per-consumer rate limiting: 10 msg/s, 100 KB/s
- [ ] Minimal web consumer: connect, pair, decrypt, render, input, permissions
- [ ] ACP research notes with Phase 3 confidence assessment
- [ ] CI/CD pipeline updated for crypto deps and cloudflared
- [ ] Crypto overhead < 5ms/msg (abort trigger)
- [ ] Same-region RTT < 200ms through tunnel (abort trigger)
- [ ] Full integration test: mobile browser → tunnel → daemon → Claude Code → response
- [ ] 28 security test cases passing (per Security Expert matrix)

**Abort triggers checked**:
- Crypto overhead > 5ms → implementation wrong
- Same-region RTT > 200ms → architecture wrong
- Cross-region RTT > 500ms → investigate

---

## Phase 3: Extract Library + ACP + Codex Adapters (4-6 weeks)

**Goal**: Extract reusable library core and validate it against two fundamentally different protocols.

### 3.1 Library Extraction (1-2 weeks)

**Restructure**: Move protocol-agnostic code into clean library API:
- `src/core/` — SessionBridge, UnifiedMessage, BackendAdapter (already done in Phase 1)
- Clean public API surface: `import { SessionBridge, BackendAdapter, UnifiedMessage } from "beamcode"`
- BackendAdapter documentation already written in Phase 1b.7
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

**Note**: Codex CLI `app-server` mode is experimental. If it doesn't work as expected, stdio JSONL fallback is available — but switching transport mid-implementation is a fundamentally different adapter architecture, not a "3-5 day" task. If `app-server` fails early, switch to stdio immediately rather than debugging the experimental mode.

**Initialization**: `initialize` → response → `initialized` handshake before session start

**Message model**: Codex uses Thread/Turn/Item hierarchy:
- Thread = conversation session
- Turn = user/assistant exchange
- Item = individual content piece (text, tool call, tool result)

Map to UnifiedMessage: Thread → session, Turn → message group (parentId), Item → content block

**Approval flow**: Codex command/file approvals → bridge permission requests → user response → Codex approval/denial

**Why Codex validates the library**: Same transport as SdkUrl (WebSocket) but fundamentally different message model (Thread/Turn/Item JSON-RPC vs flat NDJSON events). With SdkUrl + ACP + Codex, BackendAdapter is tested across all 4 transport × protocol combinations:
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
- [ ] UnifiedMessage changed ≤ 2 times during Phase 3 (abort trigger)

**Abort trigger**: UnifiedMessage changes > 2 times → type too SdkUrl-specific, stop and redesign. (Tightened from > 3 per review recommendation — blast radius is larger with relay + encryption + reconnection code depending on the type.)

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
| Phase 0 | Unit + property-based | UnifiedMessage serialization, interface compliance, deterministic JSON |
| Phase 1a | Unit | Message translation roundtrips, state reducer, ProcessSupervisor |
| Phase 1b | Unit + integration + rewrite | ConsumerMessage redesign, SessionBridge refactor (417+ tests pass), test file structural rewrite |
| Phase 2 | Unit + integration + E2E + security | Daemon lifecycle, crypto (28 security tests), reconnection, tunnel RTT benchmarks |
| Phase 3 | Contract + integration | Adapter compliance suite, cross-adapter message fidelity |
| All | CI | `vitest run` on every commit, coverage ≥ 80% |

**Security test matrix (Phase 2)** — 28 tests across 6 categories:
1. **Cryptographic** (5): sealed box roundtrip, tamper detection, crypto_box roundtrip, wrong key rejection, key memory protection
2. **Pairing flow** (5): happy path, expiry enforcement, double pairing rejection, post-revocation pairing, concurrent race
3. **HMAC** (7): valid signature, tampered behavior, tampered updatedInput, replay, expired timestamp, cross-request replay, nonce overflow
4. **Rate limiting** (4): message rate (11th rejected at 10/s), byte rate (101KB rejected at 100KB/s), recovery, per-consumer isolation
5. **Transport** (4): origin validation, CLI auth token, invalid path close code 4000, non-UUID session ID close code 1008
6. **Integration** (3): full relay encrypt/decrypt through mock tunnel, revocation prevents messages, stale key reconnection fails

### Dependency Management

| Dependency | Phase | Purpose | Pinning |
|---|---|---|---|
| `sodium-native` | Phase 2 (daemon) | E2E encryption with real `mlock` | Exact version, optional peer dep |
| `libsodium-wrappers-sumo` | Phase 2 (browser) | E2E encryption (WASM) | Exact version (no caret) |
| `cloudflared` (binary) | Phase 2 | Tunnel sidecar (not npm) | Verify SHA256 checksums |
| None (vanilla + CDN markdown) | Phase 2 | Web consumer | — |

### Configuration

All config stored in `~/.beamcode/`:
- `daemon.lock` — lock file
- `daemon.state.json` — daemon state (PID, port, heartbeat, control API bearer token)
- `sessions/` — per-session state files (via FileStorage)
- `keys/` — keypair storage (daemon private key, paired device public keys)

**Key storage concerns**: `~/.beamcode/keys/` may be synced by iCloud on macOS. Consider:
- macOS: `~/Library/Application Support/beamcode/keys/` (not synced)
- OS keychain integration (Keychain Access on macOS, libsecret on Linux) for daemon private key
- File-based with `0600` permissions is acceptable for MVP but is the weakest option

### Error Handling Principles

- Adapters must NOT throw on individual message failures — log and continue
- Daemon must NOT crash on individual session failures — isolate and report
- E2E decryption failure on a single message: log, skip, continue (don't tear down session)
- Tunnel disconnection: exponential backoff reconnect, don't stop daemon
- CLI crash: auto-restart via SessionManager (existing behavior)

### Known Deferred Items

These are explicitly deferred and will need addressing post-MVP:

| Item | Impact | When It Returns |
|------|--------|-----------------|
| Process persistence across daemon restarts | Daemon crash kills ALL sessions; users lose in-progress work | First production user who loses work |
| Multi-device support | Only one mobile device per daemon; no laptop + phone simultaneously | First user request for multi-device |
| Session file encryption at rest | Private keys stored as files on disk | First security audit |
| Forward secrecy | Compromise of daemon's long-term key reveals ALL crypto_box messages | Post-MVP security hardening |
| Traffic analysis mitigations | Message sizes reveal interaction patterns through tunnel | Post-MVP privacy hardening |

---

## Risk Mitigations

| Risk | Probability | Mitigation |
|---|---|---|
| Phase 1 scope explosion (test rewrite, ConsumerMessage) | HIGH | Split into 1a/1b. Abort trigger at 5 weeks. |
| Phase 2 scope explosion | HIGH | Hard timebox 8 weeks + 1 week contingency. E2E scope cut at day 12. |
| Extraction gamble (relay-biased abstractions) | MEDIUM | ACP + Codex validate universality. < 500 LOC success signal. |
| Codex WS mode experimental | MEDIUM | stdio JSONL fallback. Switch early, not late. |
| CF free tier changes | MEDIUM | trycloudflare.com for dev only. Production requires CF account. |
| E2E crypto bug | LOW | Use libsodium (audited). No custom crypto. 28-test security matrix. |
| ESM + sodium-native integration | MEDIUM | Budget 1-2 days for WASM/N-API integration. Test early in Phase 2.3. |
| cloudflared not supporting WebSocket | LOW | Smoke test on day 1 of Phase 2.2. |

---

## Milestone Summary

| Week | Milestone | Key Deliverable |
|---|---|---|
| 2.5 | Phase 0 complete | UnifiedMessage (envelope-centric, no seq), BackendAdapter, security quick wins, RateLimiter fix |
| 4 | Phase 1a complete | SdkUrlAdapter skeleton, ProcessSupervisor extracted, message translator + state reducer |
| 7.5-9.5 | Phase 1b complete | SessionBridge rewired, ConsumerMessage redesigned, 3,030 LOC test rewrite, BackendAdapter docs |
| 10-12 | Daemon + tunnel working | Daemon-without-tunnel milestone, cloudflared integration, control API with auth |
| 12-14 | E2E + reconnection | Sealed box/crypto_box, pairing link, HMAC signing, backpressure before encryption |
| 14-16 | Web consumer + ACP research | Minimal web client, ACP research notes |
| 16.5 | Phase 2 complete | Full relay MVP: mobile → tunnel → daemon → Claude Code |
| 18-19 | ACP adapter | JSON-RPC/stdio, library validation |
| 20 | Codex adapter | JSON-RPC/WS, 3-adapter validation matrix |
| 21-23 | Phase 3 complete | Library extracted, npm v0.2.0 published |
| 24-26 | Phase 4 (stretch) | AgentSdk adapter (if on schedule) |
