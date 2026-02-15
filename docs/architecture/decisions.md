# Architecture Decisions: Universal Adapter Layer

**Date**: 2026-02-15
**Status**: Approved (v2.1 — Relay-First MVP, post-review revision)
**Context**: Decisions made after 8-expert RFC review + 5-expert v1 decision review + 5-expert v2 decision review. V2 pivoted from "library-first, relay-aware" to "relay MVP drives library design" based on Devil's Advocate finding that relay is the core differentiator. V2.1 incorporates conditions from the v2 review panel (Oracle, Devil's Advocate, Security Expert, Implementation Validator, Momus).

**Previous versions**: See git history for v1 (library-first) and v2 (relay-first, pre-review).

---

## Strategic Pivot: Why Relay-First

The v1 decisions chose "library first, relay-aware" — design adapter abstractions, then build relay later. The 5-expert decision review panel exposed three fatal problems with that approach:

1. **Devil's Advocate**: "SSH+tmux already solves 'use a CLI agent from a different terminal.' The ONLY thing this project offers that doesn't exist is mobile access to running agent sessions. By choosing library first, you're building the thing that has the LEAST competitive advantage first." (55% reversal likelihood, VERY HIGH reversal cost)

2. **Consistency Checker**: "Untested interfaces rot. Nothing in the MVP exercises serialization, reconnection, or JWT auth. The types will be wrong when relay arrives." (HIGH severity)

3. **Momus**: "Relay has a 10% probability of ever shipping if deferred. By deferring it, you're burying your core value proposition."

4. **Oracle** (from original review): "Daemon/relay should be Phase 4, not deferred. Current plan delays mobile by 6+ months. Relay is the core differentiator vs SSH+tmux."

**The pivot**: Use a relay MVP to **drive** the library design. Abstractions emerge from working relay code, not from speculation. This guarantees correct interfaces because they were extracted from reality, not designed in a vacuum.

**Acknowledged risk (Devil's Advocate)**: Relay-first may produce relay-biased abstractions. Mitigation: design interfaces in Phase 0 by thinking about SdkUrl AND ACP requirements; use composed interfaces so relay-specific needs are additive extensions; validate with ACP and Codex in Phase 3 — two fundamentally different protocols as "customer zero" and "customer one."

---

## Decision 1: Product Vision — Relay MVP Drives Library Design

**Choice**: Build a minimal relay (daemon + tunnel + reconnection) with SdkUrl only. Then extract the library abstractions from working code. The relay IS the product; the library is the reusable foundation that falls out of building it.

**Rationale**:
- Relay is the core differentiator — mobile access to running agent sessions
- "Design for relay but don't build it" produces untested interfaces that rot (all 5 reviewers)
- Competitors already have remote session access (Cursor, Windsurf)
- Building relay first forces correct abstractions for serialization, reconnection, auth, and backpressure
- The library emerges naturally as the protocol-agnostic core extracted from the relay implementation

**What "Relay MVP" means (and doesn't mean)**:
- Single user, single device remote access to Claude Code sessions
- SdkUrl adapter only (no ACP, Codex, or AgentSDK yet)
- Cloudflare Tunnel for connectivity (simplest path, no custom infrastructure)
- E2E encryption (non-negotiable for remote access)
- Basic reconnection with message replay
- **Minimal web consumer** for human testing (500-1000 LOC) — *(added per Momus condition)*
- Does NOT mean: push notifications, streaming modes, multi-device sync, mobile app

**What this changes from v1**:
- Relay is no longer deferred — it's Phase 2
- E2E encryption is no longer deferred — it's Phase 2 (blocking for relay)
- Protocol types (message IDs, seq numbers) are implemented and tested, not just defined
- Auth interfaces are built against real tunnel requirements, not speculative

---

## Decision 2: Implementation Order — Build Vertical, Then Widen

**Choice**: Build a complete vertical slice (SdkUrl + relay) first, then widen to other adapters.

### Phase 0: Foundation (2 weeks)

**UnifiedMessage + BackendAdapter interface design.** This was identified as "Decision 0" by all 5 reviewers — it blocks everything.

1. **UnifiedMessage type** — Normalized message format across all adapters
   - Lowest-common-denominator for core fields (type, content, role)
   - Metadata escape hatch for adapter-specific data (`metadata: Record<string, unknown>`)
   - Unknown message type passthrough (forward-compatible)
   - Message IDs and sequence numbers from day one (not bolted on later)
   - **Design for both SdkUrl AND ACP** — consider streaming (SdkUrl) and request/response (ACP) models during type design, not just relay needs

2. **BackendAdapter / BackendSession interfaces** — Split into composed interfaces per DX Designer
   - `BackendAdapter`: `connect(): BackendSession`, `capabilities: BackendCapabilities`
   - `BackendSession` (core): `send(message): void`, `messages: AsyncIterable<UnifiedMessage>`, `close(): void`
   - `Interruptible` (optional): `interrupt(): void`
   - `Configurable` (optional): `setModel()`, `setPermissionMode()`
   - `PermissionHandler` (optional): permission request/response bridging
   - **Relay extensions** (composed, not baked in): `Reconnectable`, `Encryptable` — these are ADDITIVE interfaces, not part of the core contract

3. **Subprocess ownership** — Adapter owns process spawning (CLILauncher becomes SdkUrlLauncher)

4. **Security quick wins** (not deferred — needed for relay)
   - WebSocket origin validation (1 day)
   - CLI auth tokens (3-5 days)

### Phase 1: SdkUrl Adapter Extraction (3-4 weeks)

Extract SdkUrl-specific logic from SessionBridge into `SdkUrlAdapter`.

- Decompose `routeCLIMessage` (12 handlers, ~400 LOC) into adapter
- Extract `CLILauncher` into `SdkUrlLauncher`
- Generalize `SessionState` (split into `CoreSessionState` + adapter metadata)
- Generalize event map (`cli:connected` → `backend:connected`)
- SessionBridge consumes only `UnifiedMessage`

**Abort trigger**: Phase 1 takes > 3 weeks → abstraction is wrong, stop and redesign.

### Phase 2: Relay MVP (6-8 weeks)

Build the core differentiator. This is the phase that makes the project worth building.

*Timeline revised from 4-5 weeks per Implementation Validator (7-8 week estimate) and Momus (8-9.5 week estimate, reduced to 6-8 with scope cuts below).*

**Daemon (2 weeks)**:
- Child-process model — daemon manages CLI processes as direct children using the existing `ProcessManager` interface. If the daemon stops, child processes stop too. Session *state* (conversation history, settings) persists via `FileStorage` and is restored on restart.
  - **Reusable from current codebase (~50%)**: `CLILauncher` (548 LOC, session lifecycle, PID tracking, crash recovery, kill escalation), `SessionManager` (340 LOC, auto-relaunch, reconnect, idle reaping), `FileStorage` (213 LOC, atomic writes, WAL pattern)
  - **New**: lock file, state file, HTTP control API, signal handling, heartbeat
- Lock file with `O_CREAT | O_EXCL` (atomic, prevents race conditions)
- State file: PID, port, heartbeat timestamp, CLI version
- Local control API: minimal HTTP on `127.0.0.1:0` (session list, create, stop, **revoke-device**)
- Signal handling: graceful shutdown with session cleanup
- Health check: 60-second heartbeat loop
- **No tmux dependency**: Simpler model — no runtime dependency, no new process management abstraction, no port-change reconnection problem. Process persistence (sessions surviving daemon restart) deferred to post-MVP; when needed, alternatives to tmux (e.g., systemd user services, process groups, container-based supervision) should be evaluated.

**Relay (1.5-2 weeks)**:
- `TunnelRelayAdapter` using Cloudflare Tunnel (zero server infrastructure, requires CF account for production)
- `cloudflared` runs as a sidecar reverse proxy to daemon's local WebSocket server — incoming connections are proxied to `localhost:PORT` *(clarified per Momus: this is a reverse proxy model, NOT outbound WebSocket from daemon)*
- Session routing: relay forwards by session ID (existing `/ws/consumer/:sessionId` path works as-is)
- Reconnection: exponential backoff with fast failover on network change

**E2E Encryption (2-2.5 weeks)** — BLOCKING, non-negotiable:
- libsodium sealed boxes (XSalsa20-Poly1305)
- **Pairing link for key exchange** (not QR code for MVP) — daemon generates URL containing public key + tunnel address; user opens on mobile device. Saves 3-5 days vs QR scanning flow. *(Simplified per Momus and Impl Validator)*
- **Tunnel-blind architecture**: the relay/tunnel cannot decrypt message contents, but the local bridge process has full plaintext access for protocol translation. *(Clarified per Implementation Validator — "zero-knowledge" was misleading; bridge must see plaintext to translate CLIMessage → ConsumerMessage)*
- **Permission response signing**: HMAC-SHA256 with session-bound secret + nonce + timestamp + request_id binding. Nonce tracked (last 1000, bounded by 30-second timestamp window) to prevent replay. *(Replay protection added per Security Expert)*
- **Encrypted message envelope format**: *(Added per Security Expert)*
  ```typescript
  interface EncryptedEnvelope {
    v: 1;              // Protocol version (for future crypto upgrades)
    sid: string;       // Session ID (plaintext, for routing)
    ct: string;        // Base64url ciphertext
    len: number;       // Original plaintext length (for allocation)
  }
  ```
- **Session revocation**: `revoke-device` command in daemon control API — generates new keypair, deletes mobile public key, requires re-pairing. Even minimal revocation is essential for compromised device response. *(Added per Security Expert)*

**Reconnection Protocol (1-1.5 weeks)** — explicitly budgeted, not "included":
- Stable consumer IDs that survive socket reconnects (not socket-reference identity)
- Message IDs and sequence numbers on all ConsumerMessages (wrapper approach: `SequencedMessage<T>` at serialization boundary)
- `reconnect` / `reconnect_ack` message flow with last-seen replay
- Message history pagination (virtual scrolling: send last 20, fetch previous on scroll)
- Per-consumer send queues with high-water mark (backpressure)

**Minimal Web Consumer (1-1.5 weeks)** — *(added per Momus)*:
- Single-page HTML/JS app (500-1000 LOC)
- Connects to tunnel WebSocket, handles E2E decryption
- Renders messages, sends input, handles permission requests
- Required for human testing and dogfooding — without this, relay is "infrastructure tested only by automated tests, used by nobody"

**Phase 2.5: ACP Research (during weeks 7-8 of Phase 2)** — *(added per Oracle)*:
- 3-5 days of parallel ACP research: read the ACP spec, prototype throwaway JSON-RPC client, test against Goose's ACP server
- Read-only work that doesn't require library extraction
- De-risks Phase 3 and eliminates ramp-up gap

### Phase 3: Extract Library + ACP + Codex Adapters (4-6 weeks)

Now that relay works, extract the reusable library and validate it against two additional protocols. *(Extended from 3-5 weeks to include Codex adapter; 1 week rework buffer per Momus)*

**Library extraction (1-2 weeks)**:
- Extract protocol-agnostic core from relay code into clean library APIs
- The abstractions are correct because they came from working code
- Contract tests: verify SdkUrlAdapter complies with BackendAdapter interface
- **Success signal**: ACP adapter requires < 500 LOC beyond the adapter itself (Momus)
- **Failure signal**: ACP adapter requires > 1000 LOC AND library type changes (Momus)

**ACP Adapter (2-3 weeks)**:
- JSON-RPC over stdio
- Capability negotiation
- PTY sidecar for features ACP doesn't expose (slash commands)
- Validates library abstractions against a fundamentally different protocol (stdio + request/response vs WebSocket + streaming)
- **Must be implemented by someone other than the relay developer** — the "library customer" test (Oracle)

**Codex CLI Adapter (3-5 days)**:
- OpenAI's Codex CLI via `codex app-server --listen ws://host:port` (WebSocket) or stdio JSONL
- Modified JSON-RPC 2.0 protocol — translate Thread/Turn/Item model to UnifiedMessage
- Initialization handshake (`initialize` → response → `initialized`) before session start
- Approval flow mapping: Codex command/file approvals → bridge permission requests
- **Why Codex**: Tests a different dimension than ACP — same transport (WebSocket) but different message model (JSON-RPC vs NDJSON, Thread/Turn/Item hierarchy vs flat events). With SdkUrl (NDJSON/WS), ACP (JSON-RPC/stdio), and Codex (JSON-RPC/WS), the BackendAdapter is validated across all 4 transport×protocol combinations.
- **Low risk**: Well-documented protocol, TypeScript SDK as reference, ~600-800 LOC adapter

**Abort trigger**: UnifiedMessage type changes > **2** times during ACP/Codex adapter work → the type is too SdkUrl-specific, stop and redesign. *(Tightened from 3 per Momus — blast radius in v2 includes relay encryption, reconnection, and message history)*

### Phase 4: AgentSdk Adapter (stretch goal, 2-3 weeks)

**Only if Phase 3 completes on time.** This is insurance, not core scope.

- Official Anthropic SDK
- Permission bridging: Promise-to-broadcast pattern
- 50% success probability (Momus estimate) — plan for 3 adapters, celebrate 4

**Abort trigger**: Permission coordination requires > 500 LOC → too complex, defer.

---

## Decision 3: PTY Strategy — Composable Utility (unchanged)

**Choice**: Build PTY as a composable utility class that any adapter can use for specific features, NOT as a standalone adapter.

**Status**: PTY utility is 80% implemented as `PtyCommandRunner`, `SlashCommandExecutor`, `stripAnsi`, and prompt detection functions (per Implementation Validator).

**Rationale** (unchanged):
- Fill gaps in adapter protocols (e.g., ACP doesn't expose slash commands)
- Standalone PtyAdapter has EXTREME fragility risk
- Mixed-protocol approach is more robust
- Standalone adapter can be trivially built later from these utilities

**For relay context**: PTY features are inherently local — unavailable to remote clients. The protocol should include capability availability mode (`local` / `remote` / `both`) so mobile consumers know what's available (per Consistency Checker finding).

---

## Decision 4: Security — Phased with E2E in Phase 2

**Choice**: Security is no longer "quick wins now, defer the rest." E2E encryption moves to Phase 2 because relay requires it.

**Phase 0 (immediate)**:
1. **WebSocket origin validation** (1 day) — Reject untrusted origins
2. **CLI auth tokens** (3-5 days) — Per-session secret in `?token=SECRET`

**Phase 2 (with relay, blocking)**:
3. **E2E encryption** (2-2.5 weeks) — libsodium sealed boxes, pairing link key exchange
4. **Permission response signing** (3-4 days) — HMAC-SHA256 with session-bound secret + nonce + timestamp + request_id binding for replay protection *(expanded per Security Expert)*
5. **Session revocation** (2-3 days) — `revoke-device` command, new keypair generation, forced re-pairing *(added per Security Expert)*
6. **Encrypted message envelope** — `{ v, sid, ct, len }` format for tunnel routing without decryption *(added per Security Expert)*
7. **Per-consumer rate limiting** (2 days) — Max 10 msg/sec, 100 KB/sec per consumer *(added per Security Expert)*

**What this defers** (to post-MVP):
- Session file encryption at rest *(deferred per Momus — local attacker with fs access can also read daemon memory; saves 2-3 days in Phase 2)*
- Mutual TLS implementation
- Expanded RBAC model (owner/admin/reviewer roles)
- Audit logging
- JWT-based consumer authentication (uses E2E key pair instead for MVP)
- QR code scanning for key exchange (upgrade from pairing link)
- Message size padding for privacy
- Forward secrecy beyond sealed box ephemeral keys

**What changed from v1**: E2E encryption, permission signing, and session revocation moved from "deferred" to Phase 2. Session file encryption moved from Phase 2 to "deferred" (Momus recommendation). Replay protection and encrypted envelope format added (Security Expert gaps).

---

## Decision 5: Packaging — Single Package (unchanged)

**Choice**: Ship as one `beamcode` npm package. Split when community adapters emerge.

**Directory structure** (updated for relay):
```
src/
  core/              # SessionBridge, UnifiedMessage, BackendAdapter interface
    types/           # UnifiedMessage, BackendCapabilities, SessionState
    interfaces/      # Authenticator, Transport, Storage
  adapters/
    sdk-url/         # SdkUrlAdapter + SdkUrlLauncher
    acp/             # ACPAdapter (Phase 3)
    codex/           # CodexAdapter (Phase 3)
    agent-sdk/       # AgentSdkAdapter (Phase 4, stretch)
  daemon/            # NEW: DaemonAdapter, child-process supervisor, state file, lock
  relay/             # NEW: RelayAdapter, TunnelRelayAdapter, E2E encryption
  consumer/          # NEW: Minimal web consumer (Phase 2)
  utils/
    pty-bridge/      # Composable PTY utility (80% exists)
    ndjson/          # NDJSON parser (existing)
    rate-limiter/    # Token bucket (existing)
    crypto/          # NEW: E2E encryption, HMAC signing, key exchange
  server/            # WebSocket server, consumer management, reconnection
```

**Future split plan**:
```
@beamcode/core        # SessionBridge, UnifiedMessage, BackendAdapter
@beamcode/adapter-*   # Individual adapter packages
@beamcode/daemon      # Process supervisor
@beamcode/relay       # Tunnel relay + E2E encryption
@beamcode/client      # Consumer SDK (vanilla TS)
@beamcode/react       # React hooks for consumers
beamcode              # Meta-package
```

---

## Decision 6: Relay Architecture — Tunnel Model

**Choice**: Use the Cloudflare Tunnel reverse proxy model for relay MVP. Local daemon runs a WebSocket server; `cloudflared` sidecar proxies inbound HTTPS traffic to it. No custom cloud infrastructure.

**Why Tunnel (not Cloud Relay or External Tool)**:
- **Zero server infrastructure**: No server to maintain, no database, no Redis *(note: still requires CF account for production, `trycloudflare.com` for development — not truly "zero" infrastructure, per Momus)*
- **Reverse proxy model**: `cloudflared` proxies inbound connections to daemon's local WS server — existing `NodeWebSocketServer` works unchanged
- **Battle-tested**: Cloudflare Tunnel handles TLS, routing, availability
- **Simplest path**: Focus effort on daemon + E2E, not infrastructure
- **Can upgrade later**: Tunnel → custom relay server is additive, not rewrite

**Architecture** *(corrected: reverse proxy model, not outbound WebSocket)*:
```
┌─────────┐                     ┌──────────────┐
│ Mobile  │──HTTPS──►           │  Cloudflare  │
│ Browser │                     │  Tunnel Edge │
└─────────┘                     └──────┬───────┘
                                       │ proxied connection
                                ┌──────▼────────┐
                                │  cloudflared  │ (sidecar process)
                                │  reverse proxy│
                                └──────┬────────┘
                                       │ localhost:PORT
                                ┌──────▼────────┐
                                │   Daemon      │
                                │  (localhost)  │
                                │  ┌──────────┐ │
                                │  │ Session  │ │
                                │  │ Bridge   │ │
                                │  └────┬─────┘ │
                                │       │       │
                                │  ┌────▼─────┐ │
                                │  │ SdkUrl   │ │
                                │  │ Adapter  │ │
                                │  └────┬─────┘ │
                                └───────┼───────┘
                                        │
                                 ┌──────▼───────┐
                                 │  Claude Code │
                                 │  CLI (child) │
                                 └──────────────┘

All messages E2E encrypted (libsodium sealed boxes)
Tunnel sees only EncryptedEnvelope { v, sid, ct, len }
Pairing link for key exchange (QR code deferred to post-MVP)
```

**Daemon components**:
- `DaemonAdapter` interface: `spawnSession()`, `stopSession()`, `listSessions()`, `isAlive(pid)`
- Child-process supervisor: manages CLI processes via existing `ProcessManager` (spawn, kill, isAlive)
- Lock file: `~/.beamcode/daemon.lock` with `O_CREAT | O_EXCL`
- State file: `~/.beamcode/daemon.state.json` (PID, port, heartbeat, version)
- Local control API: HTTP on `127.0.0.1:0` (random port stored in state file)

---

## Summary

| Decision | Choice | Phase | Effort |
|----------|--------|-------|--------|
| Product vision | Relay MVP drives library design | — | — |
| Foundation | UnifiedMessage + BackendAdapter + security | Phase 0 | 2 weeks |
| SdkUrl extraction | Extract from SessionBridge | Phase 1 | 3-4 weeks |
| Relay MVP | Daemon + Tunnel + E2E + reconnection + web consumer | Phase 2 | **6-8 weeks** |
| ACP research | Parallel study of ACP spec | Phase 2.5 | 3-5 days (overlap) |
| Library + ACP + Codex | Extract library, validate with ACP and Codex | Phase 3 | 4-6 weeks |
| AgentSdk | Stretch goal | Phase 4 | 2-3 weeks |
| PTY | Composable utility (80% done) | Included | — |
| Security | Phased: origin+tokens now, E2E+revocation in Phase 2 | Phase 0+2 | — |
| Packaging | Single package | — | 0 |
| Relay model | Cloudflare Tunnel reverse proxy | Phase 2 | — |

**Total estimated timeline**:
- **1 engineer**: 17-22 weeks (likely 19 weeks)
- **2 engineers (parallel tracks)**: 13-15 weeks — see `docs/architecture/parallel-tracks-exploration.md`

*Timeline revised from 16-21 weeks with the addition of Codex adapter (~1 week) to Phase 3.*

**Abort triggers**:
1. Phase 1 (BackendAdapter extraction) takes > 3 weeks → abstraction is wrong
2. Permission coordination requires > 500 LOC → too complex
3. Any adapter requires PTY fallback for basic messaging (defined as: send user message, receive assistant stream, receive result) → agent not ready *(sharpened per Momus)*
4. UnifiedMessage type changes > **2** times during Phase 3-4 → type too adapter-specific *(tightened from 3 per Momus — blast radius includes relay encryption, reconnection, message history)*
5. **Crypto overhead** (encrypt + decrypt per message) > 5ms → implementation wrong *(split from original "E2E latency > 200ms" per Momus)*
6. **Same-region round-trip** through tunnel > 200ms → architecture wrong for real-time *(split)*
7. **Cross-region round-trip** through tunnel > 500ms → acceptable for MVP, investigate if > 500ms *(split)*

**What ships at ~19 weeks (1 engineer, likely case)**:
1. Working relay: mobile browser → tunnel → daemon → Claude Code session
2. Minimal web consumer for mobile access
3. BackendAdapter with SdkUrl + ACP + Codex implementations
4. E2E encryption with pairing link
5. Reconnection with message replay
6. Session revocation
7. npm package v0.2.0

**What's deferred**:
- QR code scanning (upgrade from pairing link)
- Process persistence across daemon restarts (evaluate tmux, systemd, containers when needed)
- Push notifications (APNS/FCM)
- Streaming throttle modes
- Multi-device sync
- Session file encryption at rest
- AgentSdk adapter (stretch goal)
- Custom relay server (upgrade from tunnel)
- Mobile native app
- Agent teams coordination

---

## Review Panel Reports

All expert assessments that informed these decisions:

**Original RFC review (8 experts)**:

| Expert | Report |
|--------|--------|
| Oracle Strategist | [reviews/oracle-strategist.md](./reviews/oracle-strategist.md) |
| DX Designer | [reviews/dx-designer.md](./reviews/dx-designer.md) |
| Test Architect | [reviews/test-architect.md](./reviews/test-architect.md) |
| Protocol Designer | [reviews/protocol-designer.md](./reviews/protocol-designer.md) |
| Mobile Expert | [reviews/mobile-expert.md](./reviews/mobile-expert.md) |
| Security Expert | [reviews/security-expert.md](./reviews/security-expert.md) |
| Metis Analyst | [reviews/metis-analyst.md](./reviews/metis-analyst.md) |
| Momus Critic | [reviews/momus-critic.md](./reviews/momus-critic.md) |
| Consolidated Review | [reviews/consolidated-review.md](./reviews/consolidated-review.md) |

**Decision review v1 (5 experts)**:

| Expert | Report |
|--------|--------|
| Devil's Advocate | [reviews/decisions/devils-advocate.md](./reviews/decisions/devils-advocate.md) |
| Metis | [reviews/decisions/metis.md](./reviews/decisions/metis.md) |
| Momus | [reviews/decisions/momus.md](./reviews/decisions/momus.md) |
| Implementation Validator | [reviews/decisions/impl-validator.md](./reviews/decisions/impl-validator.md) |
| Consistency Checker | [reviews/decisions/consistency-checker.md](./reviews/decisions/consistency-checker.md) |
| Synthesized Findings | [reviews/decisions/synthesized-findings.md](./reviews/decisions/synthesized-findings.md) |

**Decision review v2 (5 experts)**:

| Expert | Report |
|--------|--------|
| Oracle Strategist | [reviews/decisions-v2/oracle.md](./reviews/decisions-v2/oracle.md) |
| Devil's Advocate | [reviews/decisions-v2/devils-advocate.md](./reviews/decisions-v2/devils-advocate.md) |
| Security Expert | [reviews/decisions-v2/security-expert.md](./reviews/decisions-v2/security-expert.md) |
| Implementation Validator | [reviews/decisions-v2/impl-validator.md](./reviews/decisions-v2/impl-validator.md) |
| Momus Critic | [reviews/decisions-v2/momus.md](./reviews/decisions-v2/momus.md) |
| Synthesized Findings | [reviews/decisions-v2/synthesized-findings.md](./reviews/decisions-v2/synthesized-findings.md) |

**Parallel tracks analysis**:

| Document | Path |
|----------|------|
| Parallel Tracks Exploration | [parallel-tracks-exploration.md](./parallel-tracks-exploration.md) |
