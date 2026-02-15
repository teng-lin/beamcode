# Implementation Validator Report: v2 Relay-First Architecture vs Codebase Reality

**Date**: 2026-02-15
**Source**: Analysis of actual codebase at `src/` (61 files, 12,352 LOC)
**Compared against**: `docs/architecture/decisions.md` (v2 — Relay-First MVP)
**Previous report**: `reviews/decisions/impl-validator.md` (v1 — Library-First)

---

## 1. Daemon Feasibility

### Claim: "TmuxDaemonAdapter — simplest process supervisor (re-use tmux, already 80% built as PtyCommandRunner)"

### Reality: **Misleading. PtyCommandRunner is ~5% of what a daemon needs.**

`PtyCommandRunner` (`src/adapters/pty-command-runner.ts`, 223 LOC) is a **single-command executor**: it spawns a PTY, types a slash command, captures output, and exits. It is fundamentally a short-lived process runner. A daemon is a **long-lived process supervisor** that must:

| Daemon Requirement | PtyCommandRunner Provides | Gap |
|---|---|---|
| Long-running process supervision | Short-lived command execution | **Complete rewrite** |
| Multiple session management | Single session, single command | **New** |
| Lock file (`O_CREAT \| O_EXCL`) | None | **New** |
| State file (PID, port, heartbeat) | None | **New** |
| HTTP control API on `127.0.0.1:0` | None | **New** |
| Signal handling (graceful shutdown) | `proc.kill()` only | **Major gap** |
| Health check (60s heartbeat) | None | **New** |
| tmux integration for process survival | Uses node-pty (ephemeral) | **Fundamentally different** |

**What IS reusable from the existing codebase for a daemon:**

1. **`CLILauncher`** (`src/core/cli-launcher.ts`, 548 LOC) — This is actually where the daemon's process management logic should come from. It already handles:
   - Session lifecycle (`starting` → `connected` → `running` → `exited`)
   - Process spawning with `--sdk-url` arguments
   - PID tracking and `isAlive()` checks via `ProcessManager`
   - Kill with SIGTERM/SIGKILL escalation
   - Circuit breaker for crash loops
   - State persistence via `LauncherStateStorage`

2. **`SessionManager`** (`src/core/session-manager.ts`, 340 LOC) — The facade wiring that auto-relaunches, reconnects, and reaps idle sessions. The daemon's control loop is a superset of this.

3. **`FileStorage`** (`src/adapters/file-storage.ts`, 213 LOC) — Atomic writes with WAL pattern. Directly reusable for the daemon state file.

4. **`NodeWebSocketServer`** (`src/adapters/node-ws-server.ts`, 124 LOC) — The local WS server. The daemon would run this, not replace it.

**Corrected "80% built" claim**: The PTY utility is 80% built (true, per v1 report). The **daemon** is maybe 30% built — `CLILauncher` + `SessionManager` + `FileStorage` provide the session lifecycle and persistence, but the daemon wrapper (lock file, HTTP control API, tmux integration, signal handling, heartbeat) is entirely new.

### Is 2 weeks realistic?

**Tight but plausible IF** scoped aggressively:
- Lock file + state file: 2 days (trivial with `O_CREAT | O_EXCL` and atomic write from FileStorage)
- HTTP control API: 3 days (minimal: list sessions, create, stop — use Node's built-in `http` module)
- tmux integration: 3 days (biggest unknown — need to shell out to `tmux new-session`, `tmux list-sessions`, parse output)
- Signal handling + health check: 2 days
- Wiring CLILauncher/SessionManager into daemon context: 2 days
- Testing: 2 days (difficult — tmux in CI is fragile)

**Total: 14 working days = ~3 weeks, not 2.** The tmux integration and testing are the schedule risks.

---

## 2. Tunnel Integration

### Claim: Cloudflare Tunnel, outbound WebSocket from daemon to tunnel edge

### Reality: The existing `NodeWebSocketServer` is an **inbound** WebSocket server. Tunnel requires the **opposite direction**.

**Current architecture** (`node-ws-server.ts:51-105`):
```
CLI →(WS connect to)→ NodeWebSocketServer ←(WS connect to)← Consumer
```
Both CLI and consumers connect **inbound** to the server.

**Tunnel architecture requires**:
```
Consumer →(HTTPS)→ CF Tunnel Edge →(WS)→ Daemon
                                         ↓
                               NodeWebSocketServer (still local)
                                         ↑
                                        CLI
```

The daemon needs to:
1. Run `cloudflared tunnel` as a child process (or use CF's library)
2. Have `cloudflared` proxy incoming HTTPS connections to the local WS server
3. **OR** have the daemon make an **outbound** WebSocket connection to a CF Tunnel edge endpoint

**Integration with `NodeWebSocketServer`:**
- If using `cloudflared` as a reverse proxy to localhost → **zero changes** to `NodeWebSocketServer`. The tunnel just proxies to `127.0.0.1:PORT`. This is the simplest path.
- If using CF's tunnel library for direct integration → moderate changes to create a tunnel-aware transport.

**What needs to change:**
1. **Consumer path routing** — Remote consumers via tunnel need the same `/ws/consumer/:sessionId` path. Currently works as-is IF cloudflared proxies to the same port.
2. **Origin validation** — `req.headers.origin` will differ for tunnel-proxied connections. Need to add CF tunnel headers to the allowlist (e.g., `Cf-Connecting-Ip`, `Cf-Access-Jwt-Assertion`).
3. **Auth context enrichment** — The `AuthContext.transport` bag (line 90-96 of `node-ws-server.ts`) already captures headers and query params. For tunnel, you'd additionally capture CF-specific headers. This is additive.
4. **Session routing** — The decisions doc says "relay forwards by session ID" — this is **already how it works**. The `/ws/consumer/:sessionId` path already routes to the correct session.

**Effort estimate: 1.5-2 weeks is realistic** if using `cloudflared` as a sidecar process (spawn + monitor). The integration is mostly about running `cloudflared` and configuring it, not rewriting transport code.

---

## 3. Reconnection Implementation

### Claim: "Adding message_id and seq to ConsumerMessage costs near-zero effort" + "reconnect/reconnect_ack message flow with last-seen replay"

### Reality: Larger effort than "near-zero," but well-architected for it.

**ConsumerMessage union** (`src/types/consumer-messages.ts`) has **21 variants** (not 18 as stated in v1 — 3 were added since). Adding `message_id: string` and `seq: number` to each means:

**Option A: Add to the union type directly**
- Every variant gets `message_id` and `seq` as required fields
- Every construction site (26 calls to `broadcastToConsumers` + `sendToConsumer` in `session-bridge.ts`) must inject them
- All 38 test assertions matching on ConsumerMessage payloads break
- **Effort: 3-4 days** including test updates

**Option B: Wrapper approach (recommended)**
- Create `SequencedMessage<T extends ConsumerMessage> = T & { message_id: string; seq: number; timestamp: number }`
- Inject `message_id`/`seq` at the serialization boundary (`broadcastToConsumers` and `sendToConsumer` methods)
- Internal code keeps working with plain `ConsumerMessage`
- Only the wire format changes
- **Effort: 1-2 days** — modify 3 methods (`broadcastToConsumers`, `broadcastToParticipants`, `sendToConsumer`)

**Where the replay buffer lives:**

Currently, `session.messageHistory: ConsumerMessage[]` (line 56 of `session-bridge.ts`) already serves as a replay buffer. On consumer connect, the bridge replays it via `message_history` (line 458-463). This is **already 70% of reconnection**.

What's missing:
1. **Per-consumer tracking of last-seen sequence number** — need `Map<consumerId, lastSeenSeq>` in Session or ConsumerIdentity
2. **Reconnect message handling** — add `{ type: "reconnect"; last_seen_seq: number }` to `InboundMessage` (7 variants currently, just add 1)
3. **Partial replay** — instead of replaying all history, replay from `last_seen_seq + 1`. Requires indexing `messageHistory` by seq (currently it's just an array; would need to add seq to stored messages)

**Total reconnection effort: 4-5 days** (not the implied "near-zero" of just adding types).

---

## 4. Backpressure Implementation

### Claim: Per-consumer send queues with high-water mark

### Reality: Current `ws.send()` is fire-and-forget, but the infrastructure for queuing exists.

**Current state** (`session-bridge.ts:1220-1265`):
```typescript
private broadcastToConsumers(session: Session, msg: ConsumerMessage): void {
    const json = JSON.stringify(msg);
    for (const ws of session.consumerSockets.keys()) {
        try {
            ws.send(json);  // Fire and forget
        } catch (err) {
            failed.push(ws);  // Only catches synchronous errors
        }
    }
}
```

Problems for relay:
1. `ws.send()` on the `ws` library is actually **buffered** (Node.js `ws` queues internally), but there's no visibility into buffer size
2. For remote consumers via tunnel, backpressure means detecting when the tunnel connection is slow and pausing message sending
3. The `WebSocketLike` interface (`src/interfaces/transport.ts:1-5`) has only `send(data: string): void` — no way to know if the send buffer is full

**What's needed:**
1. Extend `WebSocketLike` to include backpressure signals: `readonly bufferedAmount: number` or `send(data: string): boolean` (returns false when buffer full)
2. Per-consumer send queue: wrap each consumer socket in a `ConsumerChannel` that maintains an outbound queue with high-water mark
3. When queue exceeds high-water mark: either drop non-critical messages (stream events, tool progress) or disconnect the consumer

**Implementation approach:**
```typescript
interface ConsumerChannel {
    send(msg: ConsumerMessage): void;
    readonly bufferedCount: number;
    readonly isBackpressured: boolean;
}
```

Replace `Map<WebSocketLike, ConsumerIdentity>` with `Map<string, ConsumerChannel>` in Session.

**Effort: 3-4 days** — moderate refactor of consumer management in SessionBridge. The tricky part is deciding which message types are droppable under backpressure (stream events yes, permission requests no).

---

## 5. E2E Encryption Integration

### Claim: libsodium sealed boxes, zero-knowledge, QR code pairing

### Where encryption/decryption happens in the pipeline:

**Current message flow:**
```
CLI → NDJSON bytes → parseNDJSON<CLIMessage> → routeCLIMessage → ConsumerMessage → JSON.stringify → ws.send(json)
Consumer → JSON.parse → InboundMessage → routeConsumerMessage → serializeNDJSON → session.cliSocket.send()
```

**With E2E encryption, the pipeline becomes:**
```
CLI → NDJSON bytes → parseNDJSON<CLIMessage> → routeCLIMessage → ConsumerMessage → JSON.stringify → encrypt(json) → ws.send(encrypted)
Consumer → decrypt(data) → JSON.parse → InboundMessage → routeConsumerMessage → serializeNDJSON → session.cliSocket.send()
```

**Critical integration point:** Encryption MUST happen AFTER `JSON.stringify` and BEFORE `ws.send`. Decryption MUST happen AFTER `ws.on("message")` and BEFORE `JSON.parse`.

**Does it work with existing NDJSON parsing?** Yes — the CLI-to-bridge channel (NDJSON) is **not encrypted** (it's localhost). Only the bridge-to-consumer channel gets E2E encryption. The NDJSON parser is unaffected.

**Where to inject encryption:**
1. **Outbound**: In `broadcastToConsumers` / `sendToConsumer` (3 methods in `session-bridge.ts`), after `JSON.stringify(msg)`, apply `encrypt(json, consumerPublicKey)`
2. **Inbound**: In `handleConsumerMessage` (`session-bridge.ts:507-568`), before `JSON.parse(raw)`, apply `decrypt(raw, consumerPrivateKey)`

**Complications:**
1. **Key management per consumer** — Each consumer has a key pair. The bridge needs to know each consumer's public key. This means `ConsumerIdentity` needs a `publicKey?: Uint8Array` field, populated during pairing.
2. **QR code pairing** — Requires a separate pairing flow (HTTP endpoint or WebSocket message) before the encrypted session starts. This is **new infrastructure** — probably 2-3 days just for the pairing endpoint.
3. **Sealed boxes are asymmetric** — Only the holder of the private key can decrypt. The bridge encrypts with the consumer's public key. But this means **the bridge CAN read plaintext** (it encrypts it!). True zero-knowledge requires the bridge to **never see** plaintext, which means the CLI itself must encrypt. This contradicts the current architecture where the bridge transforms CLIMessages into ConsumerMessages.

**This is a fundamental design tension**: If the bridge does protocol translation (CLIMessage → ConsumerMessage), it must see plaintext. Zero-knowledge encryption would mean the CLI sends already-encrypted ConsumerMessages, which requires changes to Claude Code's `--sdk-url` protocol. **The decisions document doesn't address this.**

**Possible resolution**: E2E encryption encrypts the `ConsumerMessage` payload at the bridge, making the **relay/tunnel** unable to read it, but the **local bridge process** can read it. This is "E2E" in the sense that the tunnel edge can't decrypt, but it's not zero-knowledge from the bridge's perspective. This is likely the intended meaning, and it's correct for the threat model (protecting against tunnel compromise).

**Effort: 1-2 weeks is realistic** for the encryption itself, but the zero-knowledge architecture claim needs clarification.

---

## 6. Hidden Refactoring for Relay

### Changes the decisions doc does NOT mention:

#### 6a. `Session` type needs a consumer ID system

Currently consumers are identified by `WebSocketLike` reference (`consumerSockets: Map<WebSocketLike, ConsumerIdentity>`, line 51). For reconnection, you need **stable consumer IDs** that survive socket reconnects. This means:
- Add `consumerId: string` to `ConsumerIdentity`
- Change `consumerSockets` from `Map<WebSocketLike, ConsumerIdentity>` to something like `Map<string, { socket: WebSocketLike | null; identity: ConsumerIdentity; lastSeenSeq: number }>`
- When a consumer reconnects, look up by ID, not by socket reference

**Impact**: Moderate — touches every consumer iteration in SessionBridge (~15 call sites).

#### 6b. `WebSocketServerLike` callbacks need consumer identification

The current `OnConsumerConnection` callback receives a raw socket + `AuthContext`. For reconnection, the server needs to identify whether this is a new connection or a reconnect (carrying a `consumerId` in the handshake). The `AuthContext.transport.query` bag already supports this (consumer could pass `?consumer_id=...`), but the bridge's `handleConsumerOpen` logic needs branching for reconnect vs new.

#### 6c. Message history needs sequence indexing

`session.messageHistory` is currently a plain `ConsumerMessage[]` (line 56). For reconnection replay from a specific sequence number, you need either:
- Add `seq` to each stored message (memory increase: ~8 bytes/msg × 1000 max = 8KB — negligible)
- Or maintain a separate seq-to-index map

The `trimMessageHistory` method (line 1277-1282) currently uses `slice(-maxLength)` which would lose old sequence numbers. Need to track the "base sequence number" (sequence of the oldest retained message).

#### 6d. `BridgeEventMap` needs daemon events

The event system (`src/types/events.ts`) has `cli:*` and `consumer:*` events. The daemon adds a new category: `daemon:started`, `daemon:stopped`, `daemon:heartbeat`, `tunnel:connected`, `tunnel:disconnected`. The `SessionManagerEventMap` union needs extending.

#### 6e. `ProviderConfig` needs relay configuration

The config type (`src/types/config.ts`) currently has no relay-related fields. Needs additions:
- `daemon.lockFilePath?: string`
- `daemon.stateFilePath?: string`
- `daemon.heartbeatIntervalMs?: number`
- `tunnel.provider?: "cloudflare" | "custom"`
- `tunnel.cloudflaredBinary?: string`
- `encryption.enabled?: boolean`

#### 6f. The `testing/` directory needs relay mocks

Currently has `mock-command-runner.ts`, `mock-process-manager.ts`, `mock-socket.ts`. Relay adds:
- Mock tunnel transport
- Mock encrypted channel
- Mock daemon state file
- Integration test harness for daemon → tunnel → consumer flow

---

## 7. Effort Validation — Phase by Phase

### Phase 0: Foundation (claimed 2 weeks)

| Item | Claimed | Validated | Notes |
|---|---|---|---|
| UnifiedMessage type | Part of 2 weeks | 3-4 days | Straightforward type design |
| BackendAdapter interfaces | Part of 2 weeks | 3-4 days | Small interfaces; complexity is in implementation |
| WebSocket origin validation | 1 day | 1 day | **Accurate** — 15-20 LOC in `node-ws-server.ts:64` |
| CLI auth tokens | 3-5 days | 3-5 days | **Accurate** — query param extraction exists for consumers, needs adding for CLI path |
| **Total** | 2 weeks | **2 weeks** | **Accurate** |

### Phase 1: SdkUrl Adapter Extraction (claimed 3-4 weeks)

| Item | Claimed | Validated | Notes |
|---|---|---|---|
| Extract `routeCLIMessage` (12 handlers, ~400 LOC) | Part of 3-4 weeks | 5-7 days | The handlers are cleanly separated but tightly coupled to Session state updates |
| Extract `CLILauncher` → `SdkUrlLauncher` | Part of 3-4 weeks | 2-3 days | Mostly rename + interface extraction |
| Generalize `SessionState` | Not explicitly mentioned | 3-4 days | Need `CoreSessionState + AdapterMetadata` split; touches all state readers |
| Generalize event map | Not explicitly mentioned | 2-3 days | `cli:*` → `backend:*`; 18 event consumers need updating |
| Test updates | Not explicitly mentioned | 3-5 days | 38 test assertions on ConsumerMessage types, plus all event tests |
| **Total** | 3-4 weeks | **3-4 weeks** | **Accurate** (but only because the hidden refactoring fills the gap) |

### Phase 2: Relay MVP (claimed 4-5 weeks)

| Item | Claimed | Validated | Notes |
|---|---|---|---|
| **Daemon** | 2 weeks | **3 weeks** | Lock file + state file (2d) + HTTP API (3d) + tmux (3d) + signals (2d) + wiring (2d) + testing (3d) |
| **Relay/Tunnel** | 1.5-2 weeks | **1.5-2 weeks** | Accurate IF using cloudflared as sidecar; less accurate if custom integration |
| **E2E Encryption** | 1-2 weeks | **1.5-2 weeks** | libsodium integration is straightforward; QR pairing is the schedule risk; zero-knowledge claim needs resolution |
| **Reconnection Protocol** | Part of above | **1 week** | Consumer ID system + seq tracking + partial replay + InboundMessage extensions |
| **Backpressure** | Part of above | **3-4 days** | ConsumerChannel abstraction + per-consumer queue |
| **Hidden refactoring** (6a-6f) | Not mentioned | **3-5 days** | Config extensions, event system, testing mocks |
| **Total** | 4-5 weeks | **7-8 weeks** | **Significantly underestimated** — the daemon alone consumes 3 weeks |

### Phase 3: Extract Library + ACP (claimed 3-4 weeks)

| Item | Claimed | Validated | Notes |
|---|---|---|---|
| Library extraction | 1-2 weeks | 1-2 weeks | If Phase 1 is done well, this is mostly moving code |
| ACP Adapter | 2-3 weeks | 2-3 weeks | Accurate; stdio JSON-RPC is fundamentally different but isolated |
| **Total** | 3-4 weeks | **3-4 weeks** | **Accurate** |

### Overall Timeline

| Phase | Claimed | Validated |
|---|---|---|
| Phase 0 | 2 weeks | 2 weeks |
| Phase 1 | 3-4 weeks | 3-4 weeks |
| Phase 2 | 4-5 weeks | **7-8 weeks** |
| Phase 3 | 3-4 weeks | 3-4 weeks |
| **Total** | 12-15 weeks | **15-18 weeks** |

**The gap is almost entirely in Phase 2.** The decisions document underestimates the daemon (2 → 3 weeks), underestimates reconnection (implied "near-zero" → 1 week), and doesn't account for the hidden refactoring needed for relay (consumer IDs, config, events, testing mocks: ~1 week).

---

## 8. Highest Risk Component

### **Highest Risk: TmuxDaemonAdapter**

**Why this, not the tunnel or encryption?**

1. **tmux is a runtime dependency that complicates testing and CI.** The current codebase uses `ProcessManager` interface for process abstraction — but tmux integration means shelling out to `tmux` commands, parsing their text output, and handling tmux session lifecycle. There's no good mock for tmux — you either run it or fake it, and faking it means your tests don't test the hard parts.

2. **tmux session ≠ Node.js process.** The claim is "sessions survive daemon restart." This means the CLI processes run in tmux sessions, NOT as children of the daemon's Node.js process. This changes the entire process management model:
   - Current: `ProcessManager.spawn()` returns a `ProcessHandle` with `pid`, `exited` promise, stdout/stderr streams
   - tmux: `tmux new-session -d -s <name> <command>` spawns in background; the daemon has no `ProcessHandle`, only a tmux session name to query
   - Monitoring: need to poll `tmux list-sessions` or use `tmux wait` for exit detection
   - stdout/stderr: need `tmux pipe-pane` or `tmux capture-pane` for output (lossy, fragile)

3. **The `ProcessManager` interface doesn't fit tmux.** The current interface:
   ```typescript
   interface ProcessManager {
     spawn(options: SpawnOptions): ProcessHandle;
     isAlive(pid: number): boolean;
   }
   ```
   For tmux, you'd need something like:
   ```typescript
   interface DaemonProcessManager {
     spawnInTmux(sessionName: string, command: string, args: string[]): TmuxHandle;
     listTmuxSessions(): TmuxSession[];
     killTmuxSession(sessionName: string): void;
     isSessionAlive(sessionName: string): boolean;
   }
   ```
   This is a different interface entirely. The claim that `PtyCommandRunner` provides 80% is wrong — you need a `TmuxProcessManager` that doesn't exist.

4. **WebSocket reconnection after daemon restart.** If the daemon restarts, the CLI processes (in tmux) are still alive, but the WebSocket connections from CLI to bridge are dead. The CLI's `--sdk-url` points to `ws://localhost:PORT/ws/cli/:sessionId` — if the daemon restarts on a **different port**, the CLI can't reconnect. The current `reconnectGracePeriodMs` watchdog (`session-manager.ts:279-296`) handles this for process crashes, but daemon restart is different: the sessions are in `FileStorage`, the CLIs are in tmux, and the bridge needs to:
   - Read state from disk
   - Discover running tmux sessions
   - Match them to stored sessions
   - Wait for CLIs to reconnect (or tell them to reconnect if the port changed)

   **The port change problem is unsolved.** Either the daemon must always use the same port (fragile) or the CLI needs a reconnection mechanism (doesn't exist in `--sdk-url` today).

### Second Highest Risk: E2E Encryption Zero-Knowledge Claim

As detailed in section 5, the bridge transforms CLIMessages into ConsumerMessages, meaning it sees plaintext. True zero-knowledge requires the encryption boundary to be at the CLI, not the bridge. The decisions doc claims "zero-knowledge architecture: relay cannot decrypt message contents" — this is true for the **relay/tunnel** but not for the **local bridge process**. If the threat model is tunnel compromise only (reasonable for MVP), this is fine. But the claim as written is misleading and may cause confusion during implementation.

### Third Highest Risk: QR Code Pairing

QR code pairing for key exchange requires:
- A display mechanism (web UI, terminal QR render)
- A scanning mechanism (mobile camera → key extraction)
- A secure channel to complete the pairing (temporary token exchange)
- Key storage on both sides

None of this infrastructure exists in the current codebase. It's a complete feature build — UI, crypto, and a multi-step protocol — that needs to work perfectly on first try (security-critical). The 1-2 week estimate for "E2E encryption" likely doesn't include the full pairing UX.

---

## Summary

| Aspect | v1 Assessment | v2 Assessment | Change |
|---|---|---|---|
| Architecture direction | Sound | Sound, but more ambitious | Relay adds 3 new subsystems |
| Auth interfaces | Already relay-ready | Still relay-ready | No change needed |
| PTY strategy | 80% done | 80% done (unchanged) | Correctly scoped in v2 |
| Daemon claim "80% built" | N/A (not in v1) | **False — 30% built** | CLILauncher/SessionManager reusable; daemon wrapper is new |
| Tunnel integration | N/A | **Feasible via cloudflared sidecar** | Minimal code changes if using reverse proxy model |
| E2E encryption | Deferred | Feasible but zero-knowledge claim is misleading | Bridge sees plaintext; tunnel doesn't |
| Reconnection | Type-only (v1) | Moderate effort (v2 builds it) | Consumer IDs + seq tracking + partial replay = 1 week |
| Backpressure | Not mentioned | 3-4 days for per-consumer queues | Extends existing ConsumerMessage flow |
| Time estimates | 15-20% optimistic | **Phase 2 is 50-60% optimistic** | Daemon + reconnection + hidden refactoring add 3 weeks |
| Hidden work | 5 items (v1) | 6 additional items for relay | Consumer IDs, config, events, mocks, port problem |
| Highest risk | BackendAdapter extraction | **TmuxDaemonAdapter** | tmux integration is fundamentally different from current ProcessManager |
