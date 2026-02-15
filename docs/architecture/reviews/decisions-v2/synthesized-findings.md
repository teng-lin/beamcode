# Synthesized Findings: Decisions v2 Review Panel

**Date**: 2026-02-15
**Panel**: 5 experts (Oracle Strategist, Devil's Advocate, Security Expert, Implementation Validator, Momus Critic)
**Document reviewed**: `docs/architecture/decisions.md` v2 (Relay-First MVP)

---

## Panel Verdict

| Expert | Verdict | Grade/Score |
|--------|---------|-------------|
| Oracle Strategist | **A-** | Strategic direction A, Timeline realism B+ |
| Devil's Advocate | **CRITICAL concern** on Decision 1 | 45% reversal likelihood |
| Security Expert | **CONDITIONAL APPROVE** | 3 must-fix gaps |
| Implementation Validator | **Phase 2 significantly underestimated** | 7-8 weeks, not 4-5 |
| Momus Critic | **CONDITIONAL GO** | 55% execution confidence |

**Consensus**: The relay-first pivot is **strategically correct** but **operationally underestimated**. All 5 reviewers agree the direction is right; all 5 agree the timeline is wrong.

---

## 1. Universal Consensus: Phase 2 Is Underestimated

Every reviewer independently concluded Phase 2 (4-5 weeks claimed) is significantly under-budgeted:

| Reviewer | Phase 2 Estimate | Key Driver |
|----------|-----------------|------------|
| Oracle | "14 weeks is the target" (implies ~6 weeks Phase 2) | E2E encryption + reconnection are schedule risks |
| Devil's Advocate | — (focused on strategic risk) | "3x scope increase from library to product" |
| Security Expert | +1-2 weeks over budget | Security work alone is 3-4 weeks, not 2.5-3.5 |
| Impl Validator | **7-8 weeks** | Daemon 3wk + tunnel 1.5-2wk + E2E 1.5-2wk + reconnection 1wk + hidden refactoring 1wk |
| Momus | **8-9.5 weeks** (6-8 weeks if scope cut) | Daemon 2-2.5wk + tunnel 2wk + E2E 2.5-3wk + reconnection 1.5-2wk |

**Adjusted estimate**: **6-8 weeks** for Phase 2 (with scope reductions per Momus conditions).

**Total project timeline**: **16-21 weeks** for 1 engineer (all reviewers converge on this range).

---

## 2. Daemon "80% Built" Is False

> **v2.1 Resolution**: Tmux dependency removed entirely. Daemon now uses child-process model via existing `ProcessManager`. Reuse estimate corrected to ~50%. See decisions.md v2.1.

The decisions document claims "TmuxDaemonAdapter — simplest process supervisor (re-use tmux, already 80% built as PtyCommandRunner)."

**All reviewers who assessed this agree: this is misleading.**

- **Implementation Validator**: "PtyCommandRunner is ~5% of what a daemon needs. The daemon is maybe 30% built."
- **Momus**: "PtyCommandRunner runs interactive shell commands — it doesn't manage tmux session lifecycles."

**What IS reusable** (Impl Validator assessment):
- `CLILauncher` (548 LOC) — session lifecycle, process spawning, PID tracking, crash recovery
- `SessionManager` (340 LOC) — auto-relaunch, reconnect, idle reaping
- `FileStorage` (213 LOC) — atomic writes with WAL pattern
- `NodeWebSocketServer` (124 LOC) — local WS server

**What's entirely new**: Lock file, state file, HTTP control API, signal handling, heartbeat.

---

## 3. The Daemon-Restart Port Problem (Resolved)

> **v2.1 Resolution**: Eliminated by removing tmux. Child-process model means CLI processes die with daemon — no orphaned processes needing reconnection. Session *state* persists via `FileStorage` and is restored on restart.

**Identified by**: Implementation Validator (Section 8, Highest Risk)

The original tmux-based design had an unsolved problem: if the daemon restarts on a different port, CLI processes running in tmux sessions cannot reconnect. The `--sdk-url` flag points to `ws://localhost:PORT/ws/cli/:sessionId` — the port is baked in at CLI launch time.

**Status**: No longer applicable. The child-process model sidesteps this entirely.

---

## 4. Zero-Knowledge Claim Is Misleading

**Identified by**: Implementation Validator, confirmed by Security Expert

The decisions document states "Zero-knowledge architecture: relay cannot decrypt message contents." This is correct for the **tunnel/relay** layer but misleading for the overall system.

**The reality**: The bridge process transforms CLIMessages into ConsumerMessages — it MUST see plaintext to do protocol translation. E2E encryption happens at the bridge-to-consumer boundary, making the **tunnel** blind but the **bridge** fully aware.

**Correct framing**: "Tunnel-blind architecture: the relay cannot decrypt message contents, but the local bridge process has full plaintext access for protocol translation."

**Threat model**: Protects against tunnel/Cloudflare compromise. Does NOT protect against local bridge compromise (if someone has local access, they have full access regardless).

---

## 5. Security Gaps (3 Must-Fix)

**Identified by**: Security Expert (Section 10)

### Gap 1: Replay Protection for Permission Signing
The HMAC-SHA256 scheme lacks replay protection. **Required additions**:
- Nonce (random 16 bytes, reject duplicates)
- Timestamp window (reject > 30 seconds old)
- Request ID binding in HMAC input
- **Effort**: 0.5 days design, minimal implementation

### Gap 2: Encrypted Message Envelope Format
No specification for how encrypted messages are framed on the wire.
**Required specification**:
```typescript
interface EncryptedEnvelope {
  v: 1;                    // Protocol version
  sid: string;             // Session ID (plaintext, for routing)
  ct: string;              // Base64url ciphertext
  len: number;             // Original plaintext length (for allocation)
}
```
**Effort**: 0.5 days design

### Gap 3: Session Revocation Mechanism
No way to revoke a paired mobile device. A compromised device with no revocation is an open-ended security incident.
**Required mechanism**:
- `revoke-device` command in daemon control API
- Generate new keypair on revocation
- Require re-pairing
- **Effort**: 1 day design, 2-3 days implementation

---

## 6. The Extraction Gamble

**All reviewers flagged this risk**: Building abstractions from relay code may produce relay-shaped interfaces that don't generalize to simpler adapters.

| Reviewer | Assessment |
|----------|-----------|
| Devil's Advocate | "Relay code is infrastructure code... abstractions will be shaped by infrastructure concerns" (45% reversal) |
| Momus | "With ONLY ONE working adapter, extraction produces 'SdkUrl with generics'" |
| Oracle | "35% probability library extraction produces relay-biased APIs" |
| Impl Validator | Validated that ACP's JSON-RPC model is fundamentally different from SdkUrl's streaming model |

**Mitigation consensus**:
- Have someone **other than the relay developer** implement the ACP adapter (Oracle)
- Track `if (adapter === 'sdkUrl')` branches in "generic" code (Momus)
- ACP adapter requiring < 500 LOC beyond adapter itself = success signal (Momus)
- ACP adapter requiring > 1000 LOC + library type changes = failure signal (Momus)

---

## 7. QR Code Pairing Simplification

**Momus and Impl Validator** both flagged QR code pairing as a "hidden complexity bomb":

- QR pairing is a **UX flow**, not just a crypto primitive
- Requires: QR rendering, camera access, scanning logic, key extraction
- The **consumer client** (mobile browser) that scans the QR doesn't exist in scope

**Consensus recommendation**: Replace "QR code pairing" with **"pairing link"** for MVP:
- Daemon generates a URL containing public key + tunnel address
- User opens URL on mobile device
- Eliminates camera access, QR rendering, QR scanning
- Saves 3-5 days
- Upgrade to QR in post-MVP

---

## 8. The Missing Consumer Client

**Identified by**: Momus (Bomb 1), confirmed by Impl Validator

The relay MVP builds: daemon → tunnel → ???. No consumer web client is in scope.

Without a consumer, you cannot:
- Test pairing end-to-end
- Test E2E encryption end-to-end
- Dogfood the relay as a human

**Consensus**: Add a **minimal web consumer** (500-1000 LOC, 1-2 weeks) to Phase 2 scope. Without this, Phase 2 delivers "relay infrastructure" tested only by automated tests, not by humans.

---

## 9. Parallel Tracks Alternative

**Proposed by**: Devil's Advocate (Closing section)

Instead of sequential relay-first:
- **Track 1**: Adapter abstractions (SdkUrl + ACP extraction, 4-6 weeks, 1 engineer)
- **Track 2**: Relay infrastructure (daemon + tunnel + E2E, 6-8 weeks, 1 engineer)
- **Convergence**: When relay engineer needs BackendAdapter, library engineer provides it

**Oracle's complementary recommendation**: Add "Phase 2.5" — 3-5 days of ACP research during late Phase 2 (weeks 7-8), before Phase 3 formally begins.

See `docs/architecture/parallel-tracks-exploration.md` for full analysis.

---

## 10. Abort Trigger Refinements

| Trigger | Current | Recommended Change | Reviewer |
|---------|---------|-------------------|----------|
| #3 (PTY for basic messaging) | "Any adapter requires PTY" | Define "basic messaging" as: send user msg, receive assistant stream, receive result | Momus |
| #4 (UnifiedMessage changes) | > 3 times in Phase 3-4 | **Tighten to > 2 times** — blast radius larger in v2 (affects relay + encryption + reconnection) | Momus |
| #5 (E2E latency > 200ms) | Single threshold | **Split into 3**: crypto overhead > 5ms (impl wrong), same-region RTT > 200ms (arch wrong), cross-region RTT > 500ms (acceptable) | Momus |

---

## 11. Scope Reduction Recommendations

To bring Phase 2 from 8-9.5 weeks down to 6-8 weeks:

| Cut | Savings | Impact | Reviewer |
|-----|---------|--------|----------|
| Defer session file encryption at rest | 2-3 days | LOW — local attacker with fs access can also read memory | Momus |
| Replace QR code with pairing link | 3-5 days | LOW — functionally equivalent for MVP | Momus, Impl Validator |
| Add minimal web consumer (adds time but validates relay) | +1-2 weeks | HIGH — without it, relay is untestable by humans | Momus |

---

## 12. Merged Conditions for GO

Combining all reviewer conditions into a single list:

### Must-Fix (Before Phase 2 Starts)

1. **Fix Phase 2 timeline to 6-8 weeks** (Momus, Impl Validator, Security Expert)
2. **Add minimal web consumer to Phase 2 scope** (Momus)
3. **Replace QR code pairing with pairing link for MVP** (Momus, Impl Validator)
4. **Specify replay protection for permission signing** — nonce + timestamp + request_id in HMAC (Security Expert)
5. **Define encrypted message envelope format** — `{ v, sid, ct, len }` (Security Expert)
6. **Add session revocation mechanism** — even minimal "forget device + re-pair" (Security Expert)
7. **Correct "80% built" to "~50% built" for daemon** (Impl Validator) — ✅ v2.1: tmux removed, child-process model reuses ~50%
8. **Clarify zero-knowledge claim** — "tunnel-blind, not bridge-blind" (Impl Validator) — ✅ v2.1
9. ~~**Acknowledge or solve daemon-restart port problem**~~ (Impl Validator) — ✅ v2.1: eliminated by removing tmux

### Must-Fix (During Phase 2)

10. **Tighten abort trigger #4 to 2 UnifiedMessage changes** (Momus)
11. **Split abort trigger #5** — crypto < 5ms, same-region < 200ms, cross-region < 500ms (Momus)
12. **Start parallel ACP research in late Phase 2** — study spec, prototype JSON-RPC client (Oracle)
13. **Defer session file encryption to post-MVP** (Momus)
14. **Add per-consumer rate limiting at daemon** (Security Expert)
15. **Define "basic messaging" for abort trigger #3** (Momus)

### Should-Fix (Post-MVP)

16. **Use Web Crypto API with non-extractable keys for browser key storage** (Security Expert)
17. **Document metadata leaks** in security model (Security Expert)
18. **Add message size padding** for privacy (Security Expert)
19. **Update total timeline to 16-21 weeks (1 engineer)** or explore parallel tracks for 12-14 weeks (2 engineers) (all reviewers)

---

## 13. Overall Assessment

**The relay-first pivot is the right strategic bet.** No reviewer argues relay should be deferred again. The disagreement is about execution, not direction.

**The primary risk is Phase 2 scope.** If Phase 2 balloons beyond 8 weeks, it threatens the entire project timeline and competitive window.

**The secondary risk is the extraction gamble.** Building abstractions from one adapter (relay+SdkUrl) and hoping they generalize to fundamentally different protocols (ACP's JSON-RPC) is a bet, not a certainty.

**The mitigation for both risks is the same**: Consider the parallel tracks approach (2 engineers) or at minimum, start ACP research during Phase 2 so Phase 3 has no ramp-up gap.
