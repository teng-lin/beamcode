# Synthesized Findings: Implementation Plan Review

**Date**: 2026-02-15
**Panel**: 4 experts (Oracle Strategist, Implementation Validator, Momus Critic, Security Expert)
**Document reviewed**: `docs/plans/2026-02-15-beamcode-implementation-plan.md`

---

## Panel Verdict

| Expert | Verdict | Key Metric |
|--------|---------|------------|
| Oracle Strategist | **CONDITIONAL APPROVE** (B+) | Timeline 21-23 weeks, not 19 |
| Implementation Validator | **BUILDABLE WITH CONCERNS** | Phase 1 is 5-7 weeks, total 20.5-26.5 weeks |
| Momus Critic | **CONDITIONAL GO** | 42% execution confidence |
| Security Expert | **CONDITIONALLY SECURE** | 5 must-fix security items |

**Consensus**: The plan is **strategically correct** and **grounded in real code**, but **systematically underestimates Phase 1** and has **structural contradictions** in the UnifiedMessage design. All 4 reviewers agree the direction is right; all 4 agree the timeline is wrong.

---

## 1. Universal Consensus: Phase 1 Is the Critical Risk

Every reviewer independently concluded Phase 1 (plan: 3-4 weeks) is significantly under-budgeted:

| Reviewer | Phase 1 Estimate | Key Driver |
|----------|-----------------|------------|
| Oracle | 4-5 weeks | State mutation extraction, strangler fig test problem |
| Impl Validator | **5-7 weeks** | Test rewrite (~1,500-2,000 LOC), SessionManager unaccounted |
| Momus | 4-5+ weeks (80% explosion probability on Phase 1.4) | ConsumerMessage redesign missing, event name migration |
| Security Expert | (no independent estimate) | Interface mismatch must be fixed in Phase 0 |

**Adjusted estimate**: **5-7 weeks** for Phase 1.

**Why it's harder than the plan says**:

1. **Test rewrite is massive and unplanned.** The 3,030 LOC `session-bridge.test.ts` constructs NDJSON strings and calls `handleCLIMessage()` directly. After Phase 1, this interface disappears. Every test must be rewritten to mock `BackendAdapter`/`BackendSession` or go through `SdkUrlAdapter`. The plan calls this "search-and-replace" — all reviewers call it a structural rewrite (1-2 weeks).

2. **State mutation prevents "pure function" translator.** The plan claims `SdkUrlMessageTranslator` is "pure, no side effects." But handlers mutate `session.state` with 19 field assignments across 4 methods (`handleSystemMessage`: 11 fields, `handleResultMessage`: 8 fields). These mutations must be extracted into a separate state reducer — ~150 LOC of new code.

3. **SessionManager is unaccounted for.** It appears in zero phase work items, but directly imports and wires `SessionBridge` + `CLILauncher`. When either changes, `SessionManager` must change too (~100 LOC changes + 26 event wiring statements).

4. **ConsumerMessage directly embeds CLIMessage types.** `consumer-messages.ts` imports `CLIAssistantMessage["message"]` and `CLIResultMessage` from `cli-messages.ts`. The bridge cannot become adapter-agnostic without redesigning `ConsumerMessage` — a task the plan never mentions.

---

## 2. Revised Timeline

| Phase | Plan | Oracle | Impl Validator | Momus | **Consensus** |
|-------|------|--------|----------------|-------|---------------|
| Phase 0 | 2 wk | 2-2.5 wk | 2.5 wk | 2+ wk | **2.5 weeks** |
| Phase 1 | 3-4 wk | 4-5 wk | 5-7 wk | 4-5 wk | **5-7 weeks** |
| Phase 2 | 6-8 wk | 8-10 wk | 7-9 wk | 7-9 wk | **7-9 weeks** |
| Phase 3 | 4-6 wk | 4-6 wk | 4-6 wk | 4-6 wk | **4-6 weeks** |
| **Total** | **17-22 wk** | **21-23 wk** | **20.5-26.5 wk** | **19-24 wk** | **21-26 weeks** |

Critical path is strictly sequential for 1 engineer — zero parallelism.

---

## 3. Factual Errors in the Plan

All reviewers verified claims against the codebase:

| Claim | Reality | Found By |
|-------|---------|----------|
| "12-handler routeCLIMessage (~400 LOC)" | 10 cases, ~283 LOC (lines 730-1013) | Momus, Impl Validator |
| "SdkUrlMessageTranslator: pure function, no side effects" | 19 field assignments across 4 handler methods | Impl Validator |
| "~50% reusable" for daemon | ~39% (527 LOC of 1,357 total) | Impl Validator |
| "Based on decisions.md v2.2" | Actual document is v2.1 | Momus |
| "Update all existing tests (search-and-replace, not rewrite)" | Structural rewrite of 3,030 LOC test file | Impl Validator, Momus |

---

## 4. Structural Contradictions

### 4.1 `seq` Field: UnifiedMessage vs SequencedMessage<T>

**Found by**: Momus, confirmed by Impl Validator

Phase 0.1 defines `UnifiedMessage.seq: number` baked into the core type.
Phase 2.4 introduces `SequencedMessage<T>` as a wrapper at the serialization boundary.

These are mutually exclusive designs. If `seq` is on `UnifiedMessage`, you don't need the wrapper. If you use the wrapper, `seq` doesn't belong in `UnifiedMessage`.

**Resolution**: Use the wrapper pattern. Remove `seq` from `UnifiedMessage`. Sequencing is a transport concern, not a message concern.

### 4.2 UnifiedMessage Will Be Metadata-Heavy

**Found by**: Impl Validator

The plan presents `content: UnifiedContent[]` as the primary field. In practice, only `assistant` messages use content blocks cleanly. The other 9 of 10 CLIMessage types will primarily use the `metadata: Record<string, unknown>` escape hatch:

| CLIMessage Type | Content Blocks? | Goes to Metadata |
|-----------------|----------------|------------------|
| system/init (19 fields) | No | model, cwd, tools, permissionMode, mcp_servers, agents, skills... |
| system/status | No | status, is_compacting |
| assistant | **Yes** | parent_tool_use_id |
| result (18 fields) | No | cost, turns, usage, duration, lines changed, subtype... |
| stream_event | No | opaque event |
| control_request | No | tool_name, input, suggestions |
| control_response | No | initialize response |
| tool_progress | No | tool_use_id, elapsed_time |
| tool_use_summary | No | summary, tool_use_ids |
| auth_status | No | isAuthenticating, output, error |

**Implication**: `UnifiedMessage` is really a thin envelope with a `type` discriminator and a `metadata` bag. This is architecturally fine but should be explicitly acknowledged — the plan presents it as content-centric when it's envelope-centric.

### 4.3 ConsumerMessage Coupling to CLIMessage

**Found by**: Momus

`consumer-messages.ts` directly imports and embeds `CLIAssistantMessage["message"]` and `CLIResultMessage` from `cli-messages.ts`. The plan says SessionBridge should only see `UnifiedMessage` after Phase 1, but never addresses this coupling. Without redesigning `ConsumerMessage`, the bridge is never truly adapter-agnostic.

---

## 5. Security Findings

### 5.1 Must-Fix (Before Implementation)

| # | Item | Impact | Effort |
|---|------|--------|--------|
| 1 | **Delineate sealed box vs crypto_box usage** — sealed boxes for pairing steps 5-7 only, crypto_box for all post-pairing messages | Without this, implementer may use sealed boxes everywhere, losing sender authentication | 0.5 days |
| 2 | **Include `updatedInput` in HMAC signature** — `HMAC-SHA256(secret, request_id + behavior + JSON.canonicalize(updatedInput) + timestamp + nonce)` | Without this, relay-position attacker can modify approved command while preserving valid signature | 0.5 days |
| 3 | **Remove `len` from EncryptedEnvelope** — plaintext length derivable from ciphertext length minus crypto overhead | Enables traffic analysis: small messages = user inputs, large messages = code responses | 0 days |
| 4 | **Add control API authentication** — bearer token in `daemon.state.json`, or Unix domain socket with 0700 | Any local process that reads state file can create/stop sessions and revoke devices | 1 day |
| 5 | **Enforce pairing expiry server-side with one-time use** — reject after 60s AND after one successful pairing | URL is not a secret; enforcement must be server-side | 0.5 days |

### 5.2 Interface Mismatch (Phase 0)

The `RateLimiter` interface defines `tryConsume(): boolean` (no params), but `TokenBucketLimiter.tryConsume(tokensNeeded = 1)` accepts a parameter. Must be fixed in Phase 0 to support byte-rate limiting.

### 5.3 Dependency Recommendation

Use **`sodium-native`** (N-API bindings to C libsodium) for the daemon — better key protection via real `mlock`. Use **`libsodium-wrappers-sumo`** (WASM) for the browser consumer — no native compilation needed. Pin exact versions (no caret).

### 5.4 Security Test Matrix

28 specific test cases defined across 6 categories:
- Cryptographic tests (5): sealed box roundtrip, tamper detection, crypto_box roundtrip, wrong key, memory protection
- Pairing flow tests (5): happy path, expiry, double pairing, post-revocation, concurrent race
- HMAC tests (7): valid signature, tampered behavior/updatedInput, replay, expired timestamp, cross-request, nonce overflow
- Rate limiting tests (4): message rate, byte rate, recovery, per-consumer isolation
- Transport tests (4): origin validation, CLI auth token, invalid path, non-UUID session ID
- Integration tests (3): full relay E2E, revocation, stale key reconnection

---

## 6. Missing Work Items

Tasks that must be added to the plan:

| # | Missing Item | Phase | Effort | Found By |
|---|-------------|-------|--------|----------|
| 1 | **ConsumerMessage redesign** — decouple from CLIMessage types | Phase 1 | 3-5 days | Momus |
| 2 | **Test rewrite** — 3,030 LOC session-bridge.test.ts structural refactor | Phase 1 | 1-2 weeks | Impl Validator, Momus |
| 3 | **SessionManager update** — rewire after SessionBridge/CLILauncher changes | Phase 1 | 2-3 days | Impl Validator |
| 4 | **State mutation extraction** — lift 19 field assignments into state reducer | Phase 1 | 3-4 days | Impl Validator |
| 5 | **InboundMessage (consumer→bridge) translation** — reverse path for UnifiedMessage | Phase 1 | 2-3 days | Momus |
| 6 | **Event name migration** — dual-emission logic + deprecation aliases | Phase 1 | 1-2 days | Momus |
| 7 | **PersistedSession format migration** — handle old NDJSON string format | Phase 1 | 1 day | Impl Validator |
| 8 | **cloudflared availability detection** — graceful error + install instructions | Phase 2 | 0.5 days | Oracle, Momus |
| 9 | **Daemon HTTP API tests** — request validation, error responses, auth | Phase 2 | 2-3 days | Momus |
| 10 | **Backpressure-encryption ordering** — plaintext or ciphertext? | Phase 2 | 0.5 days design | Momus |
| 11 | **CI/CD pipeline updates** — libsodium in CI, cloudflared mock, slow test strategy | Phase 2 | 2-3 days | Oracle |
| 12 | **BackendAdapter documentation** — write during Phase 1, not Phase 3 | Phase 1 | 1-2 days | Oracle |
| 13 | **Deterministic JSON serialization** — for crypto signing | Phase 0 | 1 day | Momus |

---

## 7. Scope Bombs

Tasks reviewers predict will exceed their estimates:

| Task | Plan Estimate | Explosion Risk | Realistic Estimate | Driver |
|------|--------------|----------------|-------------------|--------|
| Phase 1.4: Rewire SessionBridge | 1 week | **80%** (Momus) | 2-3 weeks | ConsumerMessage coupling, test rewrite, state extraction |
| Phase 2.3: E2E Encryption | 2-2.5 weeks | **60%** (Momus) | 2.5-3 weeks | 6 distinct subsystems + ESM/WASM integration |
| Phase 0.1: UnifiedMessage Design | 3-4 days | **50%** (Momus) | 5-6 days | JSON.stringify not deterministic, 30% loss metric undefined |
| Phase 2.5: Web Consumer | 1-1.5 weeks | **45%** (Momus) | 1.5-2 weeks | Vanilla JS + crypto + markdown + reconnection |

---

## 8. Deferred Items That Will Haunt

| Item | Why It Matters | When It Returns |
|------|---------------|-----------------|
| **Process persistence across daemon restarts** | Daemon crash kills ALL running sessions; users lose in-progress work | First production user who loses work |
| **Multi-device support** | Only one mobile device per daemon; no laptop + phone simultaneously | First user request for multi-device |
| **Session file encryption at rest** | `~/.beamcode/keys/` stores X25519 private keys as files; may be synced by iCloud on macOS | First security audit |
| **Forward secrecy** | Compromise of daemon's long-term key reveals ALL crypto_box messages (past and future) | Post-MVP security hardening |

---

## 9. Strategic Recommendations

### From Oracle Strategist

1. **Add 2 weeks of buffer** — declare 21 weeks, not 19
2. **Split Phase 1.4** into coexistence mode (adapter parallel to old path) then removal (2 steps, 1.5 weeks not 1)
3. **Timebox E2E encryption at 2.5 weeks** with hard scope cut: if pairing handshake not working by day 12, defer HMAC permission signing
4. **Move Web Consumer earlier** — start in parallel with E2E (unencrypted consumer first)
5. **Add cloudflared smoke test** to Phase 2.2 (1 day) — verify WS tunneling works before building around it
6. **Write BackendAdapter docs during Phase 1**, not Phase 3
7. **Add "daemon without tunnel" milestone at week 8** — standalone fallback ship target
8. **Fix Phase 1 abort trigger** — plan says "> 3 weeks" but estimates 3-4 weeks (trigger fires within confidence interval)

### From Implementation Validator

1. **Split Phase 1 into 1a and 1b** — Phase 1a: adapter interfaces + skeleton that wraps existing code without changing SessionBridge (1.5 weeks). Phase 1b: rewire + rewrite tests (3.5-5 weeks). Validates design cheaply before committing to expensive refactor.
2. **Account for SessionManager** in every phase — it's invisible in the plan but changes whenever SessionBridge or CLILauncher changes
3. **Acknowledge UnifiedMessage is envelope-centric**, not content-centric — treat `metadata` as normal, not exceptional
4. **Extract ProcessSupervisor base class** from CLILauncher during Phase 1.2 (add 2-3 days) — daemon needs this in Phase 2

### From Momus Critic

1. **Resolve `seq` contradiction** before writing Phase 0 code — wrapper pattern, remove from UnifiedMessage
2. **Scope Phase 1.4 honestly** — 2-3 weeks, include ConsumerMessage redesign and test rewrite
3. **Add ConsumerMessage migration** to Phase 1 — the plan never mentions it
4. **Define backpressure-encryption ordering** — determines whether backpressure layer needs message type access
5. **Budget 1 week contingency** into Phase 2
6. **Correct all factual errors** — 10 handlers not 12, ~283 LOC not ~400
7. **Add deterministic JSON serialization** investigation to Phase 0.1
8. **Specify backpressure operates on plaintext** (before encryption) — otherwise backpressure cannot inspect message types

---

## 10. Merged Conditions for GO

### Must-Fix (Before Phase 0 Starts)

1. **Resolve `seq` contradiction** — remove from `UnifiedMessage`, use `SequencedMessage<T>` wrapper only (Momus, Impl Validator)
2. **Update timeline to 21-26 weeks** — all 4 reviewers agree 17-22 is too aggressive (all)
3. **Add ConsumerMessage redesign to Phase 1 scope** — currently imports CLIMessage types directly (Momus)
4. **Add test rewrite to Phase 1 scope** — budget 1-2 weeks for 3,030 LOC structural refactor (Impl Validator, Momus)
5. **Add SessionManager updates to Phase 1 scope** — unaccounted dependency (Impl Validator)
6. **Fix Phase 1 abort trigger** — "> 3 weeks" conflicts with 3-4 week estimate; change to > 5 weeks (Oracle)
7. **Correct factual errors** — 10 handlers not 12, ~283 LOC not ~400, v2.1 not v2.2 (Momus, Impl Validator)

### Must-Fix (Before Phase 2 Starts)

8. **Delineate sealed box vs crypto_box usage** in plan (Security Expert)
9. **Include `updatedInput` in HMAC signature input** (Security Expert)
10. **Remove `len` from EncryptedEnvelope** (Security Expert)
11. **Add control API authentication** specification (Security Expert)
12. **Add pairing expiry server-side enforcement** specification (Security Expert)
13. **Fix RateLimiter interface** — add `tokensNeeded` parameter to match implementation (Security Expert)
14. **Define backpressure-encryption ordering** (Momus)
15. **Add cloudflared smoke test** to Phase 2.2 (Oracle, Momus)

### Should-Fix (During Implementation)

16. **Split Phase 1 into 1a/1b** — validate adapter design before committing to bridge refactor (Impl Validator)
17. **Write BackendAdapter documentation during Phase 1** (Oracle)
18. **Add deterministic JSON serialization** investigation to Phase 0 (Momus)
19. **Add daemon-without-tunnel milestone at week 8** as fallback (Oracle)
20. **Use dual crypto dependencies** — `sodium-native` for daemon, `libsodium-wrappers-sumo` for browser (Security Expert)
21. **Consider OS keychain** for daemon private key instead of file-based storage (Security Expert)
22. **Add 28 security test cases** per Security Expert's matrix (Security Expert)
23. **Move Web Consumer earlier** — start unencrypted version during E2E encryption work (Oracle)

---

## 11. Overall Assessment

**The plan is strategically correct and grounded in real code.** The author clearly knows the codebase — LOC counts, file locations, and architectural coupling are largely accurate. The relay-first approach with child-process daemon model is the right direction.

**The primary risk is Phase 1, not Phase 2.** All prior review rounds focused on Phase 2 timeline risk. This review reveals that Phase 1 (adapter extraction from a 1,283-line monolith while keeping 417 tests green) is the most likely schedule-breaker. The unacknowledged ConsumerMessage coupling, massive test rewrite, and SessionManager dependency combine to make Phase 1 a 5-7 week effort, not 3-4.

**The secondary risk is the UnifiedMessage design.** The type is presented as content-block-centric, but 9 of 10 message types will be metadata-dominant. If the team treats metadata as exceptional rather than normal, every adapter will fight the type system. Acknowledging this upfront and designing accordingly (envelope-first, content-blocks as a specialization) prevents rework.

**The security architecture is sound** with 5 targeted fixes. None require architectural changes — they are specification-level clarifications that can be resolved in 1-2 days of design work.

**Recommended total timeline: 21-26 weeks for 1 engineer.** Consider the parallel tracks approach (2 engineers, Track 1: adapter abstractions, Track 2: relay infrastructure) to compress to 14-16 weeks.
