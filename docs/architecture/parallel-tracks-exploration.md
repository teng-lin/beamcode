# Parallel Tracks Exploration

**Date**: 2026-02-15
**Origin**: Devil's Advocate v2 review — "The pivot solved the right problem (relay must ship) with the wrong constraint (relay must come first). Sequential execution of a parallel problem."
**Status**: Analysis for consideration

---

## The Proposal

Instead of building relay sequentially (relay first → extract library → add ACP), run two tracks in parallel:

```
Week:  1    2    3    4    5    6    7    8    9   10   11   12   13   14
       ├────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┤

Track 1 (Adapter Engineer):
       │ Phase 0: Foundation  │ SdkUrl Extraction │ ACP Adapter │
       │ UnifiedMessage       │ Decompose Bridge  │ JSON-RPC    │
       │ BackendAdapter       │ SdkUrlAdapter     │ Validation  │
       │ Security quick wins  │ Contract tests    │             │
       ├──────────────────────┼───────────────────┼─────────────┤
       2 weeks                 3-4 weeks            2-3 weeks

Track 2 (Relay Engineer):
       │ Phase 0  │ Daemon + Tunnel        │ E2E + Reconnection  │ Integration │
       │ (shared) │ Child-process daemon   │ libsodium           │ Wire relay  │
       │          │ CF Tunnel sidecar      │ Pairing link        │ to Backend  │
       │          │ HTTP control API       │ Message replay      │ Adapter     │
       ├──────────┼────────────────────────┼─────────────────────┼─────────────┤
       2 weeks     4-5 weeks                3-4 weeks              1-2 weeks

                                                          ▲
                                                          │
                                            CONVERGENCE POINT
                                   Relay engineer needs BackendAdapter
                                   Adapter engineer provides tested interface
```

**Convergence**: At ~week 8-10, the relay engineer needs `BackendAdapter` to connect the relay to session management. By this point, the adapter engineer has already built and tested it against SdkUrl AND started ACP. The interface is validated by two protocols, not one.

---

## Comparison: Sequential vs Parallel

### Timeline

| Approach | 1 Engineer | 2 Engineers | First Useful Output |
|----------|-----------|-------------|---------------------|
| **Sequential (v2 current)** | 16-21 weeks | N/A (single critical path) | Week 14 (relay + SdkUrl + ACP) |
| **Parallel tracks** | N/A (requires 2) | **12-14 weeks** | Week 6 (SdkUrl adapter library) |

### Risk Distribution

| Risk | Sequential | Parallel |
|------|-----------|----------|
| **Relay delays everything** | YES — relay blocks library extraction | NO — adapter track continues independently |
| **Wrong abstractions from relay** | HIGH — single data point (relay) shapes library | LOW — adapter track builds from 2 protocols (SdkUrl + ACP) |
| **ACP validation delayed** | YES — ACP starts at week 9+ | NO — ACP starts at week 6 |
| **Integration risk** | LOW — single engineer, single context | MEDIUM — two engineers must converge on shared interfaces |
| **Communication overhead** | ZERO | MEDIUM — daily sync on interface design needed |
| **E2E encryption risk** | Same | Same — relay track owns crypto regardless |

### Abstraction Quality

This is the key architectural argument:

**Sequential (relay-first)**: Abstractions extracted from SdkUrl + relay code. One adapter shapes the library. Risk: relay-biased interfaces that over-engineer simple adapters.

**Parallel**: Abstractions designed from SdkUrl + ACP. Two fundamentally different protocols shape the library. The relay then EXTENDS these validated abstractions. Risk: abstractions may miss relay-specific needs (reconnection, backpressure).

**The parallel approach produces better abstractions** because:
1. SdkUrl (NDJSON/WebSocket, streaming) and ACP (JSON-RPC/stdio, request/response) are maximally different
2. An interface that serves both is genuinely universal
3. Relay-specific needs (seq numbers, encryption envelope, backpressure) become EXTENSIONS of the base interface, not baked-in requirements
4. This is the "accept interfaces, return structs" principle — the simple cases define the interface, the complex case implements it

---

## How Parallel Tracks Would Work

### Shared Phase 0 (Weeks 1-2, Both Engineers)

Both engineers collaborate on foundation:
- **UnifiedMessage type** — design together, both must approve
- **BackendAdapter / BackendSession interfaces** — critical shared contract
- **Security quick wins** — origin validation, CLI auth tokens

**Deliverable**: Shared type definitions and interface contracts. Both engineers sign off before splitting.

### Track 1: Adapter Engineer (Weeks 3-14)

**Weeks 3-6: SdkUrl Extraction**
- Decompose `SessionBridge` (1,283 LOC)
- Extract `routeCLIMessage` into `SdkUrlAdapter`
- `CLILauncher` → `SdkUrlLauncher`
- Contract tests proving `SdkUrlAdapter` implements `BackendAdapter`
- **Output**: Clean `BackendAdapter` interface validated by 1 protocol

**Weeks 7-9: ACP Adapter**
- JSON-RPC over stdio
- Capability negotiation
- PTY sidecar for missing features
- **Output**: `BackendAdapter` validated by 2 fundamentally different protocols

**Weeks 10-12: Integration Support**
- Help relay engineer integrate `BackendAdapter`
- Fix interface issues discovered during relay integration
- Contract tests for relay-through-adapter flow
- **Output**: Validated end-to-end flow

**Weeks 12-14: AgentSdk Adapter (stretch)**
- Same stretch goal as v2
- Permission Promise-to-broadcast pattern
- **Output**: 3rd adapter validation (if time permits)

### Track 2: Relay Engineer (Weeks 3-14)

**Weeks 3-7: Daemon + Tunnel**
- Child-process supervisor — daemon manages CLI processes as direct children via `ProcessManager`
- Lock file, state file, HTTP control API
- Cloudflare Tunnel sidecar (cloudflared)
- Signal handling, health check
- **Output**: Working daemon with tunnel connectivity

**Weeks 7-10: E2E + Reconnection**
- libsodium sealed boxes
- Pairing link flow (not QR for MVP)
- Encrypted message envelope
- Reconnection protocol: consumer IDs, seq numbers, message replay
- Per-consumer backpressure
- **Output**: Secure relay with reconnection

**Weeks 10-12: Integration with BackendAdapter**
- Wire relay to `BackendAdapter` (provided by Track 1)
- The relay becomes a transport layer that wraps any `BackendSession`
- Integration tests: mobile browser → tunnel → daemon → BackendAdapter → SdkUrl → Claude Code
- **Output**: Complete relay MVP

**Weeks 12-14: Consumer Client + Polish**
- Minimal web consumer (500-1000 LOC)
- Pairing link UX
- Session revocation
- **Output**: Human-usable relay

### Convergence Protocol

**Weekly sync (30 min)**: Both engineers share progress, flag interface concerns.

**Critical handoff points**:
1. **Week 2**: Both sign off on `BackendAdapter` and `UnifiedMessage`
2. **Week 6**: Adapter engineer delivers contract tests. Relay engineer reviews for relay compatibility.
3. **Week 8-9**: ACP adapter reveals any interface changes needed. Both engineers agree on revisions.
4. **Week 10**: Relay engineer begins integration. Adapter engineer is available for interface fixes.

**Conflict resolution**: If the interface needs changes that affect both tracks:
- Adapter engineer owns the interface definition (they have 2 protocols of evidence)
- Relay engineer proposes extensions (composed interfaces: `BackendSession & Reconnectable & Encryptable`)
- Both must agree before any shared type changes

---

## Arguments Against Parallel Tracks

### 1. Requires Two Engineers
The decisions document assumes 1 engineer. Parallel tracks requires 2. If only 1 engineer is available, this approach is impossible.

### 2. Integration Risk
Two independent implementations must converge on shared interfaces. If they diverge significantly, integration week (10-12) becomes integration month.

**Mitigation**: Weekly sync + shared contract tests + adapter engineer owns interface definition.

### 3. Phase 0 Becomes Critical
The shared foundation (UnifiedMessage, BackendAdapter) must be right on first attempt because both tracks build on it. In sequential v2, the foundation can evolve with relay.

**Mitigation**: Phase 0 gets an extra day for both engineers to stress-test the interfaces against known protocol requirements (SdkUrl NDJSON, ACP JSON-RPC, relay reconnection needs).

### 4. Communication Overhead
Two engineers working on related code need constant coordination. Interface changes require both to stop and agree.

**Mitigation**: Clear ownership (adapter engineer owns interfaces, relay engineer owns infrastructure). Weekly sync. Slack/async for urgent interface questions.

### 5. Relay Engineer Works Without BackendAdapter for 8 Weeks
The relay engineer builds daemon and tunnel without the final `BackendAdapter` interface. They use a mock or interim adapter. When the real interface arrives at week 10, integration may require significant rework.

**Mitigation**: The relay engineer can build against the Phase 0 `BackendAdapter` contract. It won't change drastically — it may gain optional fields, but the core (connect, send, messages, close) is stable from day one.

---

## Arguments For Parallel Tracks

### 1. Better Abstractions
Interfaces shaped by SdkUrl + ACP (two simple, different protocols) are more likely to be genuinely universal than interfaces shaped by SdkUrl + relay (one protocol through infrastructure-heavy code).

### 2. Earlier Validation
ACP adapter starts at week 7, not week 10+. The "universal" claim is validated 3-4 weeks earlier. If the abstractions are wrong, you discover it with half the project remaining, not a quarter.

### 3. Risk Distribution
No single phase can sink the project. If relay is delayed, the adapter library still ships. If ACP is harder than expected, relay still ships. Neither track's failure kills the other.

### 4. Faster Time to Market
First useful output (SdkUrl adapter library) at week 6 vs week 14. Can release v0.1.0 early, get community feedback, and iterate before relay ships.

### 5. Relay Extends, Not Defines
The library interface is shaped by adapter needs (simple protocols). Relay extends it with composed interfaces (`Reconnectable`, `Encryptable`). This is the natural dependency direction — infrastructure extends abstractions, not the reverse.

### 6. Eliminates the Extraction Gamble
No "extract library from relay code" step. The library is built directly from adapter needs. No relay-biased abstractions to extract and clean up.

---

## Recommendation

### If 2 Engineers Available: Parallel Tracks

**Timeline**: 12-14 weeks
**Output at week 14**: SdkUrl adapter + ACP adapter + relay MVP with E2E encryption + minimal web consumer
**Advantage**: Better abstractions, earlier validation, risk distribution, faster first release

### If 1 Engineer Available: Modified Sequential (v2 with Oracle's Phase 2.5)

**Timeline**: 16-21 weeks
**Modification**: During late Phase 2 (weeks 7-8), allocate 3-5 days for ACP research and prototyping. This de-risks Phase 3 and ensures ACP work starts immediately when Phase 2 completes.
**Output at week 14-16**: Relay MVP with SdkUrl
**Output at week 18-21**: + ACP adapter + library extraction

### The Key Insight

The Devil's Advocate's core point is valid regardless of team size: **the library should be shaped by the simplest adapters and extended for the hardest one.** Even with 1 engineer, this principle should guide interface design:

1. Design `BackendAdapter` by thinking about SdkUrl AND ACP (Phase 0)
2. Build relay to EXTEND the interface, not define it
3. Use composed interfaces (`BackendSession & Reconnectable`) so relay-specific needs are additive
4. Let ACP validation in Phase 3 confirm the design, rather than using it as the first real test

This "design for breadth, build for depth" mindset can be applied even in the sequential approach. The parallel tracks just enforce it structurally.

---

## Decision Matrix

| Factor | Sequential (v2) | Parallel | Winner |
|--------|-----------------|----------|--------|
| Team size required | 1 | 2 | Sequential |
| Total calendar time | 16-21 weeks | 12-14 weeks | **Parallel** |
| Abstraction quality | Relay-shaped | Protocol-shaped | **Parallel** |
| First useful output | Week 14 | Week 6 | **Parallel** |
| Integration risk | Low | Medium | Sequential |
| Communication overhead | Zero | Medium | Sequential |
| Risk distribution | Concentrated | Distributed | **Parallel** |
| ACP validation timing | Week 12+ | Week 7 | **Parallel** |
| Extraction gamble | Yes (45% risk) | No | **Parallel** |
| Competitive window | Tight (14 weeks) | Comfortable (12 weeks) | **Parallel** |
