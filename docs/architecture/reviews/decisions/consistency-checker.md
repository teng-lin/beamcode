# Consistency Review: Architecture Decisions

**Reviewer**: Consistency Reviewer (Logician)
**Document**: `docs/architecture/decisions.md`
**Cross-referenced**: `docs/architecture/reviews/consolidated-review.md`

---

## 1. Contradiction Matrix

### D1 (Relay-Aware Library) vs D6 (Single Package)

**Tension: MODERATE**

D1 mandates that all interfaces, state management, and protocol types accommodate future relay — meaning auth interfaces (`Authenticator`, `JWTAuthenticator`), serializable state, reconnection semantics, and transport abstractions must exist in the core from day one. D6 says ship as a single package and split later.

The problem: D6's future split plan shows `@claude-code-bridge/relay` as a separate package. But D1 bakes relay *interfaces* into core. This means core carries the weight of relay abstractions (auth, transport, storage interfaces) even though relay is deferred. The split boundary becomes ambiguous — where does "relay-aware core" end and "relay implementation" begin?

**Verdict**: Not a hard contradiction, but the "clean split point" D6 promises will be messier than expected. The single package will accumulate unexercised relay interfaces that create maintenance burden.

---

### D2 (3 Adapters) vs D3 (Composable PTY)

**Tension: HIGH**

D3 frames PTY as an optional gap-filler: "ACP doesn't expose slash commands, use PTY sidecar." The example shows `this.pty?` — optional. But D2 rates AgentSdkAdapter at **50% success due to permission bridging complexity** (Momus).

Unstated question: **Does AgentSdkAdapter need PTY fallback for permission bridging?** The SDK uses a pull/callback model for permissions, while the bridge uses push/broadcast. The consolidated review (Finding #1) confirms this is a known race condition. If the only way to bridge permissions reliably is via PTY (intercepting the CLI's permission prompts), then PTY stops being "optional gap-filling" and becomes a **critical dependency** for the third adapter.

Additionally, the abort trigger says: "Any adapter requires PTY fallback for basic messaging -> agent isn't ready for programmatic access." If AgentSdkAdapter requires PTY for permission bridging (which is core, not extended), this triggers the abort condition for that adapter.

**Verdict**: D2 and D3 have an unresolved dependency. The decisions should explicitly state: either (a) AgentSdkAdapter's permission bridging works without PTY (with evidence), or (b) acknowledge that AgentSdkAdapter may trigger the abort condition.

---

### D4 (Protocol Types Only) vs D5 (Security Quick Wins)

**Tension: MODERATE**

D4 adds `{ type: "reconnect"; session_id: string; last_seen_seq: number }` to protocol types. D5 adds CLI auth tokens (`?token=SECRET` in URL). These interact on reconnection:

- A client reconnects with `last_seen_seq` — but how does it re-authenticate?
- The reconnect message type has no auth field.
- The auth token is in the WebSocket URL query parameter — does a reconnecting client reuse the same token? Generate a new one?

This isn't a contradiction *yet* because D4 says "defined but not implemented." But these types will need revision when actually implemented, which undermines D4's goal of "preventing breaking protocol changes when mobile/relay arrives later."

**Verdict**: The protocol types in D4 are **incomplete without D5's auth model being fully specified**. Defining types now without thinking through the auth flow means the types will likely need breaking changes anyway.

---

### D1 (Relay-Aware) vs D4 (Protocol-Ready Not Implemented)

**Tension: HIGH (Testability)**

Both D1 and D4 follow the "design now, implement later" philosophy. The risk: **untested interfaces rot.**

- D1 mandates serializable SessionBridge state. But nothing in the MVP exercises serialization. The state might not actually be serializable when relay arrives.
- D4 defines reconnect and history pagination types. But no adapter or test exercises them. The types may be wrong.
- D1 mandates auth interfaces with `AnonymousAuthenticator` as default. But `JWTAuthenticator` is never built or tested. The interface may not accommodate JWT's actual requirements (token refresh, expiry, revocation).

The consolidated review's Protocol Designer gave a **C** on implementation readiness for exactly this reason.

**Verdict**: "Protocol-ready but not implemented" is only valuable if there are **conformance tests for the protocol types themselves** — e.g., property-based tests that verify serialization round-trips, reconnection state machines, etc. Without these tests, the "relay-aware" design is aspirational, not architectural. The decisions should mandate protocol conformance tests as part of D4's "~1 week" estimate.

---

### D2 (SdkUrl Primary) vs D5 (Security Quick Wins)

**Tension: MODERATE**

D5's security fixes are **scoped to one adapter**:

- "WebSocket origin validation" — applies to the WebSocket server (consumer-side), not adapter-specific. Good.
- "CLI auth tokens — Generate random secret per session, pass as `?token=SECRET` in `--sdk-url`" — **this is SdkUrl-specific**. ACP uses stdio (no WebSocket, no URL). AgentSDK uses the official API (Anthropic handles auth).
- "Relay-ready auth interfaces" — consumer-side. Good.

So D5's second security fix (CLI auth tokens) only protects the SdkUrl adapter. The other two adapters have different trust models:
- **ACP**: stdio subprocess — inherently local, but the bridge spawns and owns the process. Security concern: command injection in CLI args.
- **AgentSDK**: API key authentication to Anthropic's servers. Security concern: API key storage and rotation.

D5 doesn't address these. This creates a false sense of security completeness.

**Verdict**: D5 should either (a) explicitly scope itself as "SdkUrl security + consumer-side security" or (b) include adapter-specific security for ACP and AgentSDK. Currently it implicitly claims to be comprehensive.

---

### D3 (Composable PTY) vs D4 (Mobile Protocol-Ready)

**Tension: HIGH (Capability Degradation)**

PTY is inherently local — you can't spawn a terminal process over a network relay. D4's protocol types are for mobile/remote consumers. This means:

- Features that ACPAdapter provides via PTY sidecar (e.g., slash commands) will **not be available** to mobile consumers accessing via relay.
- The protocol types in D4 don't include any mechanism for capability degradation based on access mode (local vs remote).
- A mobile client has no way to know that `/slash-commands` won't work because the underlying adapter uses PTY for that feature.

The `BackendCapabilities` type should distinguish between "capability available" and "capability available locally only."

**Verdict**: D3 and D4 create a **silent feature gap** for remote clients. The protocol needs a capability availability mode (local/remote/both) that D4 doesn't include.

---

### Additional Tensions Found

**D1 (Relay-Aware) vs D2 (SdkUrl Primary)**

SdkUrl is undocumented and could be removed. D1 designs for a long-lived relay product. If SdkUrl disappears before relay ships (or even before the library gets users), the primary adapter is dead and the relay-aware design work is wasted on an adapter that no longer exists. AgentSDK is the insurance policy, but at 50% success probability, that's thin insurance for a relay-aware architecture.

**D2 (3 Adapters) vs D6 (Single Package)**

Three adapters in one package means all adapter dependencies ship together. AgentSdkAdapter requires `@anthropic-ai/sdk`. ACPAdapter may need JSON-RPC libraries. Users who only want SdkUrl get bloated `node_modules`. D6 doesn't address optional/peer dependencies or tree-shaking.

**D3 (PTY) vs D5 (Security)**

PTY sidecar is an **unaddressed attack surface**. A compromised bridge could use PtyBridge to execute arbitrary commands on the host machine. D5's security analysis focuses entirely on WebSocket/network security and ignores the local process spawning risk.

---

## 2. Circular Dependencies

No hard circular dependencies exist. The dependency graph is:

```
D1 (Vision) ------+---> D4 (Protocol Types)
                   +---> D5 (Security Interfaces)
                   +---> D6 (Packaging)

D2 (Adapters) ----+---> D3 (PTY Utility)
                   +---> D5 (Auth Tokens)

D4 (Protocol) -----> D5 (Auth in Reconnect)
```

D1 and D4 have a **conceptual circularity** — D1 says "design for relay" and D4 says "add relay protocol types" — but this is vision->implementation, not a logical cycle.

The closest thing to a problematic dependency: **D4 depends on D5 for auth in reconnection types, but D5 doesn't consider D4's reconnection flow.** This is a gap, not a cycle.

---

## 3. Priority Conflicts

If resources are tight (1 engineer), these decisions compete:

| Conflict | Decisions | Shared Resource |
|----------|-----------|-----------------|
| **Type design bandwidth** | D1 + D4 | Both add protocol types/interfaces. Relay-aware interfaces (D1) and mobile protocol types (D4) should be designed together, but the decisions present them as independent 1-2 week efforts. |
| **Security vs adapters** | D2 + D5 | D5 estimates 2 weeks for security. D2 estimates 10-12 weeks for adapters. With 1 engineer, doing security first delays adapters. But shipping adapters without security (even localhost) is risky per Finding #5. |
| **Testing investment** | D2 + D4 | D2 needs contract tests per the consolidated review (3-3.5 weeks). D4 needs protocol conformance tests (unstated). Both compete for test infrastructure effort. |
| **PTY vs third adapter** | D3 + D2 | If PTY work is needed for ACP gap-filling, it must be done before or during ACP adapter work. This serializes D3->D2, reducing parallelism. |

**Highest risk conflict**: D5 (security) vs D2 (adapters). The decisions say "implement [security] now (~2 weeks)" but don't specify whether this blocks adapter work or runs in parallel. With 1 engineer, it blocks. With 2, it can parallelize — but the summary says "12-14 weeks (1-2 engineers)" without clarifying the parallelism model.

---

## 4. Completeness Check

### Fully Covered
- Product scope (library vs platform)
- Adapter selection and priority
- PTY role
- Security quick wins
- Packaging

### Partially Covered
- **Protocol types**: D4 covers mobile readiness but not general protocol versioning
- **Testing strategy**: Mentioned in consolidated review but not formalized as a decision
- **Migration path**: Consolidated review Finding #9 identifies this gap; no decision addresses it

### Missing Decisions

1. **UnifiedMessage design** — Consolidated review Finding #2 says "Implement UnifiedMessage before any adapter work. This is the foundation everything else depends on." Yet no decision addresses UnifiedMessage's structure, versioning, or extensibility. This is arguably more foundational than any of the 6 decisions.

2. **BackendSession interface decomposition** — Finding #1 says the interface bundles 6 concerns into 15+ methods and recommends splitting into cohesive interfaces. No decision addresses this.

3. **Error handling strategy** — How do adapters report errors? Is there a unified error type? How do adapter-specific errors map to consumer-facing errors?

4. **Capability negotiation** — Consolidated review Blocking Decision #4 asks "What MUST all adapters support?" The recommendation (messages, send, close, interrupt) isn't formalized as a decision.

5. **Consumer SDK** — D6's future split shows `@claude-code-bridge/client` and `@claude-code-bridge/react`. No decision addresses consumer-side SDK design, which affects D4's protocol types.

6. **Observability** — No decision on logging, metrics, or debugging tools. For a library that bridges multiple protocols, this is a significant operational gap.

---

## 5. Implementation Order

Given the dependency analysis above, the correct sequencing is:

### Phase 0: Foundation (Weeks 1-2)
**Must come first — unblocks everything**

1. **D6** (Packaging): Zero effort, just establish directory structure. Do first.
2. **Missing: UnifiedMessage type design** — This is Decision 0. Everything depends on it.
3. **Missing: BackendSession interface decomposition** — This is Decision 0b.

### Phase 1: Protocol & Security Design (Weeks 2-4)
**D1 + D4 + D5 together — they share type design surface**

4. **D1** (Relay-aware interfaces): Design serializable state, auth interfaces, transport abstraction. Do this AS PART OF the same type design session as D4.
5. **D4** (Protocol types): Add message IDs, sequence numbers, reconnection types. Design alongside D1's interfaces — they're the same type system.
6. **D5** (Security quick wins): WebSocket origin validation, CLI auth tokens, relay-ready auth interfaces. The auth interfaces should be designed with D4's reconnection flow in mind.

### Phase 2: Utilities (Week 4-5)
7. **D3** (PTY utility): Build PtyBridge, AnsiParser, PromptDetector. Must be ready before ACP adapter needs it.

### Phase 3: Adapters (Weeks 5-14)
8. **D2** (Adapters in order):
   - SdkUrlAdapter (Weeks 5-8)
   - ACPAdapter + PTY integration (Weeks 8-11)
   - AgentSdkAdapter (Weeks 11-14) — **with explicit go/no-go based on permission bridging spike**

### Critical Path Warning

The decisions present D4 and D5 as independent "+1 week" and "+2 weeks" addons. But they share type design surface with D1 and should be co-designed. Treating them as independent additions risks inconsistent interfaces (as shown in the D4 vs D5 reconnection auth gap).

---

## Summary of Findings

| Finding | Severity | Decisions | Action Needed |
|---------|----------|-----------|---------------|
| AgentSdkAdapter may need PTY for permissions, triggering abort condition | **HIGH** | D2 + D3 | Spike permission bridging before committing to AgentSdkAdapter |
| Protocol types untestable without conformance tests | **HIGH** | D1 + D4 | Add protocol conformance tests to D4's estimate |
| PTY features unavailable to remote clients (silent degradation) | **HIGH** | D3 + D4 | Add capability availability mode to protocol |
| Reconnection auth flow unspecified | **MODERATE** | D4 + D5 | Co-design reconnection types with auth model |
| Security scoped to SdkUrl adapter only | **MODERATE** | D2 + D5 | Explicitly scope D5 or add adapter-specific security |
| UnifiedMessage design missing as a decision | **HIGH** | All | Add as Decision 0 |
| BackendSession decomposition missing | **MODERATE** | D2 | Add as Decision 0b |
| PTY as unaddressed attack surface | **LOW** | D3 + D5 | Add to D5's security analysis |
| Single package bundles all adapter dependencies | **LOW** | D2 + D6 | Address optional/peer dependencies in D6 |

**Overall Assessment**: The 6 decisions are **directionally consistent** — they all point toward "library first, defer complexity." But they have **3 significant gaps** (UnifiedMessage, permission bridging viability, remote capability degradation) and **2 under-specified interactions** (reconnection auth, adapter-specific security) that need resolution before Phase 1 begins.
