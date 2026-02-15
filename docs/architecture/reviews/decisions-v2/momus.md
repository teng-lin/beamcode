# Momus Validation Report: Relay-First MVP (Decisions v2)

**Status**: CONDITIONAL GO
**Reviewed**: `docs/architecture/decisions.md` (v2 — Relay-First MVP)
**Previous review**: `reviews/decisions/momus.md` (v1 — Library-First)
**Method**: Week-by-week execution simulation against actual codebase (12,352 LOC, 7,006 LOC tests, 61 .ts files)

---

## Executive Summary

The relay-first pivot is **strategically correct** and **operationally dangerous**. V2 solves v1's biggest problem (building the wrong thing first) but introduces a new problem: Phase 2 is a distributed systems project crammed into 4-5 weeks, and it depends on a consumer client that doesn't exist in scope.

The 14-18 week estimate is achievable for the *likely case* (relay MVP + SdkUrl + ACP) but only if Phase 2's scope is ruthlessly contained. My simulation shows Phase 2 alone is 6-8 weeks, not 4-5. The total honest timeline is 16-21 weeks for 1 engineer.

---

## 1. Timeline Reality Check — Week-by-Week Simulation

### Phase 0: Foundation (Weeks 1-2) — ON TARGET

| Task | Claimed | Simulated | Notes |
|------|---------|-----------|-------|
| UnifiedMessage type | included | 3-4 days | Analyzing 21 ConsumerMessage variants + 10+ CLIMessage variants. `ConsumerMessage` directly imports `CLIAssistantMessage["message"]` and `CLIResultMessage` (consumer-messages.ts:18-26) — structural coupling that needs intermediate representations. |
| BackendAdapter/BackendSession interfaces | included | 2-3 days | Interface *design* is fast. Splitting into composed interfaces (core + Interruptible + Configurable + PermissionHandler) is a design session, not a coding marathon. |
| Subprocess ownership (CLILauncher → SdkUrlLauncher) | included | 1 day | Rename + move. CLILauncher is 548 LOC, reasonably isolated. |
| WebSocket origin validation | 1 day | 0.5 days | Adding `origin` check in `node-ws-server.ts`. Trivial. |
| CLI auth tokens | 3-5 days | 3-5 days | Generate token, pass via `--sdk-url`, validate on connect. Straightforward. |

**Verdict**: 2 weeks is achievable IF you're decisive about UnifiedMessage. The "lowest-common-denominator + metadata escape hatch" decision eliminates bikeshedding. But if you get into philosophical debates about message shape, this stretches to 3 weeks.

**Risk**: SessionState has 28 fields, many SdkUrl-specific (`claude_code_version`, `mcp_servers`, `git_branch`, `is_worktree`, etc.). The decision to split into `CoreSessionState` + adapter metadata sounds clean but requires touching every consumer of SessionState. Budget 1 day for this that isn't listed.

### Phase 1: SdkUrl Extraction (Weeks 3-6) — MATCHES V1 ESTIMATE

Same as my v1 analysis. SessionBridge is 1,283 LOC with zero separation between transport, state, and business logic. `routeCLIMessage` has a 12-handler switch (line 730+). `sendToCLI` calls `serializeNDJSON` directly (line 1181). Permission handling is bidirectional with `pendingPermissions` Map (line 55) threaded through 15+ call sites.

`session-bridge.test.ts` is 3,030 LOC — every test assumes SessionBridge IS the bridge. Moving NDJSON parsing to SdkUrlAdapter breaks them all.

**Simulated**: 3-4 weeks. Consistent with v1. No change.

### Phase 2: Relay MVP (Weeks 7-14) — THE PROBLEM

This is where v2 diverges from v1 and where the simulation gets ugly.

#### Week 7-8: Daemon (claimed: 2 weeks)

| Component | Time | Reality |
|-----------|------|---------|
| Lock file (`O_CREAT\|O_EXCL`) | 0.5 days | Node.js has no native `O_CREAT\|O_EXCL`. You use `fs.openSync(path, 'wx')`. Fine, but add cross-platform testing. |
| State file (PID, port, heartbeat, version) | 0.5 days | JSON write/read. Trivial. |
| Local HTTP control API | 2-3 days | HTTP server on `127.0.0.1:0`, routes for session CRUD. Need to pick a framework (raw `http.createServer` vs express vs fastify). |
| TmuxDaemonAdapter | 3-4 days | **Not 80% built.** `PtyCommandRunner` (pty-command-runner.ts) runs *commands* in a PTY. It does NOT manage tmux sessions. Tmux session management means: `tmux new-session -d`, `tmux list-sessions`, `tmux kill-session`, plus parsing tmux output to discover orphaned sessions on daemon restart. This is new code. |
| Signal handling + health check | 1 day | SIGTERM/SIGINT handlers, 60s heartbeat loop. Standard. |
| Tests | 2 days | Daemon integration tests need process spawning, lock file contention tests, health check verification. |

**Simulated daemon**: 2-2.5 weeks. Close to claimed, but the "80% built" claim for tmux is misleading. PtyCommandRunner runs interactive shell commands — it doesn't manage tmux session lifecycles (create, list, attach, kill, survive restart).

#### Week 9-10: Tunnel Relay (claimed: 1.5-2 weeks)

| Component | Time | Reality |
|-----------|------|---------|
| CF Tunnel setup | 1 day | Install `cloudflared`, create tunnel, configure DNS. **Requires a Cloudflare account and domain.** "Zero infrastructure" is misleading — zero *server* infrastructure, but you need CF account + DNS. |
| Outbound WebSocket (daemon → tunnel edge) | 2-3 days | The daemon connects OUT to the tunnel. But `cloudflared` handles this — you configure it to proxy to `localhost:PORT`. The daemon's WebSocket server (already exists as `NodeWebSocketServer`) receives connections from `cloudflared`. **Wait — this is backwards.** `cloudflared` proxies inbound HTTPS to a local service. The daemon doesn't connect outbound. The tunnel terminates at CF edge, CF routes to `cloudflared` running locally, `cloudflared` proxies to daemon's HTTP/WS server. |
| Session routing | 1-2 days | Relay needs to route by session ID. Currently `node-ws-server.ts` already routes via `/ws/cli/:sessionId` and `/ws/consumer/:sessionId`. This extends naturally. |
| Reconnection (exponential backoff) | 2 days | This is CLIENT-side reconnection to the tunnel, not the reconnection protocol. Standard exponential backoff with jitter. |
| Tests | 2 days | **How do you test a CF Tunnel?** Options: (a) mock `cloudflared` — complicated, (b) integration test with real tunnel — requires internet + CF account + DNS, (c) test against the local WebSocket directly, skip tunnel. Option (c) is the only sane choice for CI. |

**Simulated relay**: 2 weeks. Close to claimed, but with a critical realization: the architecture diagram in the decisions doc shows "outbound WebSocket from daemon to tunnel edge" but Cloudflare Tunnel works the opposite way — `cloudflared` runs locally and *receives* inbound connections proxied from the edge. This is an architectural misunderstanding or ambiguity that will cost 1-2 days to resolve.

#### Week 11-12: E2E Encryption (claimed: 1-2 weeks)

| Component | Time | Reality |
|-----------|------|---------|
| libsodium bindings | 0.5 days | `sodium-native` npm package. Battle-tested. |
| Sealed box encrypt/decrypt | 1 day | `crypto_box_seal` / `crypto_box_seal_open`. Standard. |
| Key exchange (QR code pairing) | **3-5 days** | **THIS IS THE HIDDEN BOMB.** QR code pairing requires: (1) key generation on daemon, (2) encoding public key + tunnel URL into QR code, (3) displaying QR code to user (terminal? web page?), (4) scanning QR on mobile browser (WebRTC camera access OR manual URL entry), (5) establishing encrypted channel. The Tailscale model uses a coordination server for this. Without a coordination server, you need a direct pairing flow. **Who builds the QR scanner?** The mobile browser consumer — which is NOT in scope. |
| Permission HMAC signing | 1 day | `crypto.createHmac('sha256', sessionSecret)`. Trivial. |
| Message encryption layer | 2 days | Every message through the tunnel needs: serialize → encrypt → base64 → send, and reverse on receive. This intercepts the entire message flow. SessionBridge's `sendToConsumer()` and `handleConsumerMessage()` need an encryption middleware. |
| Session file encryption at rest | 2-3 days | XChaCha20-Poly1305 for `PersistedSession` in `FileStorage`. Need to integrate with OS keychain (macOS Keychain, Linux secret-service). Cross-platform keychain access in Node.js requires `keytar` or similar. |
| Tests | 2 days | Crypto tests are straightforward (deterministic with known keys). Integration tests with encryption middleware are harder. |

**Simulated E2E**: 2.5-3 weeks, NOT 1-2 weeks.

The QR code pairing alone is 3-5 days because it's a *UX flow*, not just a crypto primitive. And session file encryption with OS keychain integration is another 2-3 days of cross-platform work.

#### Week 13-14: Reconnection Protocol (claimed: included in Phase 2)

| Component | Time | Reality |
|-----------|------|---------|
| Message IDs + seq numbers | 0.5 days | If added to UnifiedMessage in Phase 0, this is just populating the fields. |
| Reconnect/reconnect_ack flow | 2-3 days | Client sends `reconnect` with `last_seen_seq`. Server replays from history. Need to handle: (a) message not in history, (b) history too large, (c) client reconnects during active stream. |
| Message history pagination | 1-2 days | Virtual scrolling: last 20 messages on connect, fetch previous on scroll. `message_history` ConsumerMessage type already exists (line 50) but has no pagination. |
| Per-consumer send queues + backpressure | 2-3 days | Currently `sendToConsumer` calls `ws.send()` directly. Need: per-consumer queue, high-water mark (pause upstream when queue full), drain event handling. This is 200-300 LOC of queue management. |
| Tests | 1-2 days | Reconnection tests need to simulate disconnect/reconnect cycles. |

**Simulated reconnection**: 1.5-2 weeks.

#### Phase 2 Total

| Component | Claimed | Simulated | Gap |
|-----------|---------|-----------|-----|
| Daemon | 2 weeks | 2-2.5 weeks | +0.5 weeks |
| Tunnel relay | 1.5-2 weeks | 2 weeks | +0.5 weeks |
| E2E encryption | 1-2 weeks | 2.5-3 weeks | **+1-1.5 weeks** |
| Reconnection | included | 1.5-2 weeks | **+1.5-2 weeks** |
| **Total Phase 2** | **4-5 weeks** | **8-9.5 weeks** | **+4-4.5 weeks** |

**The 4-5 week estimate for Phase 2 is FANTASY.** It assumes:
1. Reconnection protocol has zero cost (it's "included")
2. QR code pairing is trivial (it's a UX flow)
3. Session file encryption is trivial (it's cross-platform keychain work)
4. Testing a tunnel requires no special infrastructure
5. Backpressure is free (it's 200-300 LOC of queue management)

**Realistic Phase 2**: 6-8 weeks for 1 engineer, 5-6 weeks if you cut session file encryption and simplify key exchange to manual URL paste instead of QR scanning.

### Phase 3: Extract Library + ACP (Weeks 15-18 or 20-24) — THE GAMBLE

**Library extraction (claimed 1-2 weeks)**:

After Phase 2, your relay code has SdkUrl assumptions baked in:
- `routeCLIMessage` maps CLIMessage types to ConsumerMessage types (SdkUrl-specific)
- `sendToCLI` uses NDJSON serialization (SdkUrl-specific)
- SessionState has 28 fields, ~20 are SdkUrl-specific
- Permission flow matches SdkUrl's push model

"Extracting abstractions from working code" sounds rigorous, but with ONLY ONE working adapter, your extraction produces "SdkUrl with generics." You need the SECOND adapter (ACP) to know which parts are truly generic vs. accidentally SdkUrl-specific.

**Simulated**: 1-2 weeks for extraction, but with HIGH rework probability when ACP reveals assumptions. Budget 1 week of rework.

**ACP Adapter (claimed 2-3 weeks)**: Same as v1 estimate. JSON-RPC over stdio, capability negotiation, PTY sidecar. 2-3 weeks. But now the risk is different: ACP is the VALIDATION of the extraction. If it doesn't fit, you rework both the library AND the relay integration. This is the "extraction gamble" — see Section 3.

### Phase 4: AgentSdk (stretch, 2-3 weeks) — UNLIKELY

Same as v1. 50% success probability. The Permission Promise-to-broadcast pattern requires 300-500 LOC. Plan for 2 adapters, celebrate 3.

### Actual Timeline: 16-21 Weeks

| Phase | Decisions v2 | My Simulation | Gap |
|-------|-------------|---------------|-----|
| Phase 0: Foundation | 2 weeks | 2 weeks | On target |
| Phase 1: SdkUrl extraction | 3-4 weeks | 3-4 weeks | On target |
| Phase 2: Relay MVP | 4-5 weeks | **6-8 weeks** | **+2-3 weeks** |
| Phase 3: Library + ACP | 3-4 weeks | 3-5 weeks (incl. rework) | +0-1 weeks |
| Phase 4: AgentSdk | 2-3 weeks (stretch) | 2-3 weeks (stretch) | On target |
| **Total (without stretch)** | **12-15 weeks** | **14-19 weeks** | **+2-4 weeks** |
| **Total (with stretch)** | **14-18 weeks** | **16-21 weeks** | **+2-3 weeks** |

**The 14-18 week claim is the optimistic envelope.** 16-21 weeks is the honest range for 1 engineer. With 2 engineers (one on test infra + daemon, one on core extraction + relay), 14-16 weeks is achievable.

---

## 2. Relay MVP Scope Validation

**Question**: Is "single user, single device, CF Tunnel, E2E encryption, basic reconnection" actually minimal?

**Answer**: No. There are four hidden complexity bombs:

### Bomb 1: The Missing Consumer

The relay MVP builds: daemon → tunnel → ???

Who connects to the tunnel endpoint? "Mobile browser" is listed but no consumer web client is in scope. Without a consumer, you can't:
- Test QR code pairing (needs a scanner)
- Test E2E encryption end-to-end (needs both sides)
- Dogfood the relay (no way to use it as a human)

**Minimum viable consumer**: A single-page HTML/JS app that connects to the tunnel WebSocket, handles E2E decryption, renders messages, sends input, and handles permission requests. This is 500-1000 LOC and 1-2 weeks of work. IT IS NOT IN THE SCOPE.

**Fix**: Either (a) add a minimal web consumer to Phase 2 scope (+1-2 weeks), or (b) accept that Phase 2 delivers "relay infrastructure" tested only by automated integration tests, not by humans. Option (b) is dangerous — you're building a product nobody can use.

### Bomb 2: QR Code Pairing is a Product Feature, Not a Crypto Primitive

The decisions doc says "QR code pairing for key exchange (Tailscale model)." Tailscale uses a coordination server + OAuth flow + device authorization. The "QR code" part is the simplest piece of a complex pairing flow.

For the MVP without a coordination server, QR code pairing means:
1. Daemon generates keypair, encodes public key + tunnel URL into QR
2. Daemon displays QR code (where? terminal `qrcode-terminal`? a local web page?)
3. Mobile browser scans QR (how? `navigator.mediaDevices.getUserMedia` for camera? Or manual URL entry?)
4. Mobile browser extracts public key, generates its own keypair, sends its public key to daemon
5. Both sides derive shared secret

Steps 3-4 require the consumer client (see Bomb 1). Step 2 requires a decision about display method. None of this is specified.

**Fix**: Replace "QR code pairing" with "pairing link" for MVP. Daemon prints a URL containing the public key (like `https://tunnel.example.com/pair?key=base64...`). User opens URL on mobile. This eliminates camera access, QR rendering, and QR scanning. Upgrade to QR in v2.

### Bomb 3: Cloudflare Tunnel is Not "Zero Infrastructure"

"Zero infrastructure" means no server to maintain. But it still requires:
- A Cloudflare account (free tier available)
- `cloudflared` installed on the daemon machine
- A tunnel token or tunnel configuration
- DNS record (if using a custom domain) OR a `trycloudflare.com` quickstart URL (ephemeral, changes on restart)

For development, `trycloudflare.com` works (no account needed). For production, you need a CF account. This is manageable but "zero infrastructure" is marketing, not engineering.

**Bigger issue**: The architecture diagram shows "outbound WebSocket from daemon to tunnel edge" but CF Tunnel works as a reverse proxy. `cloudflared` runs locally and receives inbound connections from CF's edge. The daemon's existing `NodeWebSocketServer` can serve these connections directly — `cloudflared` just proxies to `localhost:PORT`. This is actually SIMPLER than the diagram suggests, but the diagram's direction is wrong and will confuse implementers.

### Bomb 4: Encrypted Message Flow Intercepts Everything

E2E encryption means every message through the relay must be: `serialize → encrypt → encode → send` and `receive → decode → decrypt → deserialize`. This isn't a drop-in middleware — it changes the contract of `sendToConsumer()` and the consumer message handler.

Currently, `sendToConsumer` (session-bridge.ts) directly calls `ws.send(JSON.stringify(msg))`. With E2E, it needs to call `ws.send(encrypt(JSON.stringify(msg), consumerPublicKey))`. But the bridge doesn't know about encryption — only the relay layer does. This forces a layered architecture:

```
SessionBridge → [plain ConsumerMessage] → RelayTransport → [encrypted blob] → CF Tunnel → Consumer
```

This is clean in theory, but it means the relay can't just "wrap" the existing WebSocket — it needs to intercept at the message serialization boundary. The `WebSocketLike` interface (`send(data: string)`) isn't sufficient because the relay needs to encrypt before sending, which means the relay must sit between SessionBridge and the WebSocket.

**Fix**: The existing `WebSocketLike` interface is actually the right seam — create an `EncryptedWebSocket` that wraps `WebSocketLike` and encrypts on `send`, decrypts on receive. The interface stays the same. This is ~100 LOC and 1 day. **This one is fine, I'm being too cautious.**

---

## 3. The Extraction Gamble

Phase 3 assumes abstractions emerge cleanly from relay code. This is the central bet of v2.

### The Theory

"Abstractions are correct because they came from working code." This is the Extract Method / Extract Class refactoring pattern applied at the architectural level. Build one implementation, then extract the reusable parts.

### The Problem

You need TWO implementations to know what's generic. With one implementation (SdkUrl + relay), every "abstraction" you extract is isomorphic to the concrete implementation. Consider:

| Concept | SdkUrl Reality | ACP Reality | Generic? |
|---------|---------------|-------------|----------|
| Message format | NDJSON lines | JSON-RPC | No — fundamentally different wire format |
| Process lifecycle | `--sdk-url` flag, WebSocket | stdio subprocess | No — different spawn model |
| Permission flow | Push (CLI sends request) | Pull (ACP callback) | No — opposite directions |
| Session state | 28 fields (git, cost, etc.) | Unknown — ACP exposes different metadata | Unknown |
| Reconnection | Message replay from history | N/A for stdio (local) | SdkUrl-specific? |

The extraction will produce a `BackendAdapter` interface that looks like SdkUrl because it was extracted from SdkUrl. When ACP arrives, you'll discover:
1. The wire format abstraction is wrong (NDJSON vs JSON-RPC)
2. The lifecycle abstraction is wrong (WebSocket vs stdio)
3. The permission abstraction is wrong (push vs pull)

### How You Know Extraction Worked

**Success signal**: ACP adapter implementation requires < 500 LOC of new code beyond the adapter itself. The library provides enough infrastructure that the adapter is just a translation layer.

**Failure signal**: ACP adapter requires > 1000 LOC AND changes to the library's core types. This means the library is a SdkUrl wrapper, not a generic framework.

**Abort trigger #4 (UnifiedMessage changes > 3 times) is good but insufficient.** Also track:
- Number of `if (adapter === 'sdkUrl')` branches in "generic" code
- Whether `BackendSession.messages: AsyncIterable<UnifiedMessage>` actually works for ACP (JSON-RPC responses are request/response, not streaming)

### My Assessment

**Extraction will be PARTIALLY successful.** The transport layer (WebSocket vs stdio) will abstract cleanly — this is a solved problem. The message format (UnifiedMessage) will require 1-2 revisions when ACP arrives. The permission model will NOT abstract cleanly and will require the composed interface pattern (core + optional PermissionHandler) to paper over the push/pull mismatch.

**Expected rework**: 1-2 weeks in Phase 3 to fix extraction assumptions. The decisions doc's 1-2 weeks for extraction + 2-3 weeks for ACP should be: 1 week extraction + 2-3 weeks ACP + 1 week rework = 4-5 weeks total. The 3-4 week claim is tight.

---

## 4. Abort Trigger Validation

### Trigger 1: Phase 1 takes > 3 weeks → abstraction is wrong

**Measurable?** YES, with the same caveat from v1: define "done" as "existing integration tests pass with SdkUrlAdapter injected."

**Assessment**: Good trigger. Unchanged from v1. **KEEP.**

### Trigger 2: Permission coordination requires > 500 LOC → too complex

**Measurable?** YES. Same as v1.

**Assessment**: Good trigger. Applies to Phase 4 (AgentSdk). **KEEP.**

### Trigger 3: Any adapter requires PTY for basic messaging → agent not ready

**Measurable?** PARTIALLY. "Basic messaging" still undefined.

**V2 context**: With relay in scope, this trigger has additional meaning — PTY features are local-only. If an adapter needs PTY for basic messaging AND that adapter runs through the relay, it's fundamentally broken (PTY can't work over a tunnel).

**Fix**: Define "basic messaging" as: (1) send user message, (2) receive assistant message stream, (3) receive result. If ANY of these three requires PTY, abort. **SHARPEN.**

### Trigger 4: UnifiedMessage changes > 3 times in Phase 3-4 → too SdkUrl-specific

**Measurable?** YES. Count git commits that modify `UnifiedMessage` type definition.

**V2 context**: More important in v2 than v1, because v2 builds relay on top of UnifiedMessage before ACP validates it. If UnifiedMessage changes during Phase 3, the relay's encryption layer, reconnection protocol, and message history all need updates.

**Assessment**: Good trigger but the BLAST RADIUS is larger in v2. In v1, UnifiedMessage changes affected the library only. In v2, they affect library + relay + daemon. Consider: **trigger fires at 2 changes instead of 3** given the higher cost. **TIGHTEN.**

### Trigger 5: E2E encryption adds > 200ms latency → architecture wrong for real-time

**Measurable?** YES, but the threshold needs decomposition.

Components of round-trip latency:
- Encryption (libsodium sealed box): ~0.1ms
- Base64 encoding: ~0.05ms
- Network to CF edge: 10-50ms (depends on geography)
- CF edge to CF edge (if consumer in different region): 10-100ms
- Network from CF edge to consumer: 10-50ms
- Decryption: ~0.1ms
- **Total: 30-200ms for network + ~1ms for crypto**

The crypto overhead is negligible. The 200ms threshold is really measuring NETWORK LATENCY through CF Tunnel, not encryption cost. If a user in Tokyo connects to a daemon in San Francisco, 200ms is EXPECTED even without encryption.

**Fix**: Measure encryption overhead in isolation: `time(encrypt + decrypt)` must be < 5ms per message. Measure total latency separately and set threshold at 500ms for cross-region, 200ms for same-region. The current trigger conflates crypto overhead with network latency. **SPLIT.**

---

## 5. V1 vs V2 Comparison

### What V1 Got Right That V2 Changes

| V1 Approach | V1 Benefit | V2 Sacrifice |
|-------------|-----------|--------------|
| Library first | Ships faster (10-12 weeks to usable library) | Delays library to week 14+ |
| Relay deferred | Lower execution risk | Higher execution risk (Phase 2 scope) |
| Security deferred | Less upfront investment | E2E encryption blocking (~3 weeks) |
| 2-3 adapters MVP | Validates abstraction early | Only 1 adapter before relay |

### What V2 Gets Right That V1 Missed

| V2 Approach | V2 Benefit | V1 Failure |
|-------------|-----------|------------|
| Relay first | Builds the differentiator | Deferred indefinitely (10% ship probability) |
| E2E in scope | Security non-negotiable for remote | Cherry-picked cheapest security items only |
| Extraction from code | Interfaces tested by reality | Interfaces designed by speculation |
| Single vertical slice | Complete user story | Abstract library nobody can use |

### Risk Comparison

| Risk Category | V1 Risk | V2 Risk | Which is worse? |
|---------------|---------|---------|-----------------|
| **Strategic** | Building the wrong thing | Building the right thing badly | **V1 is worse** — wrong thing can't be fixed |
| **Execution** | 14-17 weeks (my v1 estimate) | 16-21 weeks (my v2 estimate) | **V2 is worse** — 2-4 weeks longer |
| **Scope creep** | "Just one more adapter" | "Just one more relay feature" | **V2 is worse** — relay features are addictive (push notifications, streaming modes, multi-device) |
| **Abstraction rot** | Interfaces untested by relay | Interfaces shaped by one adapter only | **Tie** — both produce imperfect abstractions, v2's are grounded in reality at least |
| **External dependency** | SdkUrl flag removal (Anthropic) | CF Tunnel pricing/API changes (Cloudflare) | **V2 adds risk** — now TWO external dependencies |
| **Testability** | Easy (all local, no network) | Hard (tunnel, E2E, reconnection) | **V2 is worse** — distributed system testing |
| **Abandonment** | Can ship library without relay | Can ship relay without library | **Tie** — both have a useful intermediate artifact |

### The Bottom Line

V1 is **safer to execute** but **more likely to produce a product nobody needs** (SSH+tmux already exists for local terminal access).

V2 is **harder to execute** but **solves the actual problem** (mobile access to running agent sessions).

**V2 is the right choice** if — and only if — Phase 2 scope is contained. If Phase 2 becomes a 12-week project-within-a-project, v2 is strictly worse than v1 because you get neither the library NOR the relay on time.

---

## 6. Verdict: CONDITIONAL GO

The relay-first pivot is strategically sound. It addresses the three fatal problems identified by the v1 review panel (building the wrong thing first, untested interfaces, 10% relay ship probability). But the execution plan has a 4-5 week gap in Phase 2 that will sink the project if not addressed.

### Conditions for GO

**Condition 1: Fix Phase 2 Timeline**

State 6-8 weeks for Phase 2, not 4-5. The decisions doc hides reconnection protocol cost ("implemented, not just types" — but WHERE is the time?), underestimates E2E encryption (QR pairing is a UX flow), and doesn't account for the missing consumer client.

Revised timeline: **16-20 weeks (1 engineer)** or **13-16 weeks (2 engineers, one on daemon/relay, one on extraction/adapters)**.

**Condition 2: Add Minimal Consumer Client to Scope**

The relay MVP is untestable without a consumer. Add a minimal web client (500-1000 LOC) to Phase 2 scope. Without this, "relay MVP" is "relay infrastructure" — tested by integration tests, used by nobody.

If consumer client is truly out of scope, explicitly state that Phase 2 delivers *infrastructure* validated by automated tests, and that human-usable relay requires a follow-on consumer project.

**Condition 3: Simplify Key Exchange for MVP**

Replace "QR code pairing (Tailscale model)" with "pairing link" for MVP. Daemon generates a URL containing the public key + tunnel address. User opens URL on mobile device. This eliminates camera access, QR rendering, and QR scanning — saving 3-5 days.

Upgrade to QR code pairing in v2 when the consumer client is mature.

**Condition 4: Tighten Trigger #4 to 2 Changes**

UnifiedMessage changes > 2 times (not 3) during Phase 3 should trigger redesign. In v2, UnifiedMessage changes cascade into relay (encryption, reconnection, history) — the blast radius is larger than v1.

**Condition 5: Split Trigger #5**

Replace "E2E latency > 200ms" with:
- Crypto overhead (encrypt + decrypt per message) > 5ms → implementation wrong
- Same-region round-trip > 200ms → architecture wrong
- Cross-region round-trip > 500ms → acceptable for MVP

The current trigger conflates crypto performance with network latency.

**Condition 6: Defer Session File Encryption**

Session file encryption at rest (XChaCha20-Poly1305 + OS keychain) is 2-3 days of cross-platform work. It protects against a local attacker who has filesystem access — but if they have filesystem access, they can also read the daemon's memory. Defer to post-MVP. This saves 2-3 days in Phase 2.

### What V2 Fixes From My V1 Conditions

| My V1 Condition | V2 Status |
|-----------------|-----------|
| Fix timeline (14-17 weeks) | ADDRESSED but still optimistic (14-18 claimed, 16-21 realistic) |
| Sharpen abort trigger #3 | PARTIALLY — still needs "basic messaging" defined |
| Add abort trigger #4 (UnifiedMessage changes) | ADOPTED (> 3 times during Phase 3-4) |
| Budget test infrastructure | NOT ADDRESSED — still invisible in timeline |
| Scope AgentSdk as stretch | ADOPTED (Phase 4 marked "stretch goal, only if Phase 3 completes on time") |

### What V2 Introduces That V1 Didn't Have

| New Risk | Severity | Mitigation |
|----------|----------|------------|
| Phase 2 scope explosion | **HIGH** | Hard timebox at 7 weeks. If daemon + relay aren't working by week 7, cut E2E to transport-only (no pairing, no at-rest encryption) |
| Missing consumer client | **HIGH** | Add minimal web consumer to scope OR accept infrastructure-only delivery |
| CF Tunnel dependency | MEDIUM | `trycloudflare.com` for dev, full account for production. Document fallback to direct WebSocket (no tunnel) for development |
| Extraction gamble (1 adapter → library) | MEDIUM | Accept 1-2 weeks of rework in Phase 3. Budget for it. |
| Distributed system testing | MEDIUM | Test crypto and reconnection locally. Test tunnel in nightly CI only, not per-commit. |

### Scope Creep Vectors (Updated for V2)

| Vector | Probability | Mitigation |
|--------|------------|------------|
| "Push notifications" | 80% | The moment relay works, someone wants APNS/FCM. HARD DEFER. |
| "Multi-device sync" | 70% | Two phones watching the same session. Sounds easy, requires conflict resolution. DEFER. |
| "Streaming throttle modes" | 60% | Mobile consumers drowning in stream_events. Addressed by backpressure, not by throttle modes. |
| "Custom relay server" | 50% | "CF Tunnel is limiting, let's build our own relay." This is 3-6 months of work. DEFER. |
| "Mobile app" | 40% | "Web is janky, let's build a native app." React Native or Swift. Separate project. DEFER. |

### Final Score

| Dimension | Score | Change from V1 |
|-----------|-------|----------------|
| Strategic soundness | **9/10** | +1 (relay is the right thing to build) |
| Timeline realism | **4/10** | -1 (Phase 2 is worse than v1's underestimates) |
| Abort trigger quality | **7/10** | Same (trigger 5 needs splitting, trigger 3 still vague) |
| Scope discipline | **8/10** | -1 (relay opens more creep vectors than library) |
| Execution confidence | **55%** | -10% (distributed systems are harder than local libraries) |
| Decisions quality | **8/10** | Same (well-reasoned pivot, good expert integration) |

**CONDITIONAL GO. Fix the 6 conditions above. Expect 16-20 weeks, not 14-18. Phase 2 is the make-or-break.**
