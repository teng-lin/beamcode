# Metis Pre-Planning Analysis: Architecture Decisions Document

**Scope**: Review of `decisions.md` against 8 expert reports + consolidated review
**Finding severity**: CRITICAL > HIGH > MEDIUM

---

## 1. HIDDEN ASSUMPTIONS

### Decision 1: Library First, Relay-Aware

**Assumption A1: "Relay-aware" design costs only "+1-2 weeks"**
- The decisions document claims adding relay-awareness to the library costs 1-2 weeks of extra design.
- **Reality**: The Metis analyst report (A2, A6) demonstrates that making SessionBridge truly serializable and stateless requires fundamental changes — not just adding fields. Current `SessionBridge.sessions` is an in-memory Map. `consumerSockets` and `pendingPermissions` are in-memory-only. Making these "serializable" means either (a) accepting data loss on restart, or (b) implementing a persistence layer that doesn't exist.
- **If wrong**: The "relay-aware" interfaces become dead code that nobody uses, adding maintenance burden. Or worse, they constrain the library design to accommodate a relay architecture that changes significantly once actual implementation begins.

**Assumption A2: Deferring relay doesn't lose competitive position**
- Oracle explicitly argues daemon should be Phase 4, not deferred, because it's the core differentiator vs SSH+tmux.
- The decisions document cites Oracle as supporting deferral, but Oracle actually says: "Relay is core differentiator" and "Current plan delays mobile by 6+ months."
- **If wrong**: A competitor ships mobile access first and captures the market position.

### Decision 2: Adapter Priority — SdkUrl + ACP + AgentSDK

**Assumption A3: `--sdk-url` will remain stable enough to build on**
- The document acknowledges it's "unofficial and undocumented" and adds AgentSdkAdapter as "insurance."
- **Hidden assumption**: That the team can maintain TWO adapters for the same CLI (SdkUrl + AgentSdk) without one becoming stale. Momus rates AgentSdkAdapter at 50% success. If SdkUrl is the primary AND AgentSdk is insurance, you're committing to maintaining both indefinitely.
- **If wrong**: SdkUrl breaks, AgentSdkAdapter is half-built, and the primary use case (Claude Code) is unsupported.

**Assumption A4: ACP targets "5-6 confirmed agents" but the adapter will be worth 3 weeks of effort**
- The document correctly downgrades from "25+" to "5-6" agents.
- **Hidden assumption**: That those 5-6 agents (Goose, Kiro, Gemini CLI) will have stable, consistent ACP implementations. The ACP spec is draft and rapidly evolving (Momus: MEDIUM fragility). Each agent may implement ACP subtly differently.
- **If wrong**: ACPAdapter becomes 5-6 mini-adapters with agent-specific workarounds, defeating the "one adapter, many agents" thesis.

### Decision 3: PTY Strategy — Composable Utility

**Assumption A5: Adapters will have "specific features" that PTY can fill**
- The document positions PTY as filling "gaps in adapter protocols" (e.g., ACP doesn't expose slash commands).
- **Hidden assumption**: That PTY sidecar output parsing is reliable enough for production use, even for limited features. Momus says PTY "Breaks every time CLI updates output format" and rates it EXTREME fragility.
- **If wrong**: The PTY utility is too fragile for production and the features it's meant to fill remain permanently unavailable.

### Decision 4: Mobile Readiness — Protocol-Ready

**Assumption A6: Adding `message_id` and `seq` to types costs "near-zero effort"**
- Defining the types is trivial. But the Mobile Expert report shows that message IDs and sequence numbers are useless without: (a) server-side message storage keyed by sequence, (b) reconnection handling that replays from last-seen sequence, (c) pagination logic, (d) gap detection.
- **Hidden assumption**: That types-only changes provide meaningful future-proofing. They don't — they provide a false sense of progress.
- **If wrong**: When mobile actually arrives, the types need to change because the actual reconnection protocol design reveals requirements the types didn't anticipate.

### Decision 5: Security — Quick Wins

**Assumption A7: WebSocket origin validation and CLI auth tokens are sufficient for the library phase**
- **Hidden assumption**: That all library users will run on localhost. The Security Expert (T1, T7, T8) warns that even localhost isn't fully safe — any process on the machine can connect without CLI auth tokens.
- **Hidden assumption**: That users won't attempt remote access with the library alone (without relay). Users WILL try `--host 0.0.0.0` and expose sessions to LAN. The security document warns about this (T8) but the decisions document doesn't address it.
- **If wrong**: Users deploy the library with non-localhost binding, no TLS, no E2E encryption, and expose sessions to their network.

### Decision 6: Single Package

**Assumption A8: 12k LOC doesn't need package splitting**
- Current codebase is 12k LOC. Adding 3 adapters (10-12 weeks of work) will roughly double it.
- **Hidden assumption**: That package consumers want ALL adapters. A user who only needs ACPAdapter must install SdkUrlAdapter and AgentSdkAdapter dependencies too.
- **If wrong**: Package becomes bloated with unused dependencies, install size grows, and tree-shaking doesn't help with Node.js.

---

## 2. MISREPRESENTATIONS

### M1: Decision 1 misrepresents Oracle's position on relay timing

**What decisions.md says**: "Oracle: Relay is core differentiator, but deferring implementation is acceptable if architecture accommodates it"

**What Oracle actually says**: "The daemon/relay layer (currently Phase 8) should be **Phase 4**, immediately after the ACP adapter, because remote access is the core differentiator vs SSH+tmux" and "Current plan delays mobile by 6+ months."

**Oracle's position is NOT "deferring is acceptable"** — Oracle explicitly argues AGAINST deferral and wants it moved up. The decisions document selectively quotes Oracle to justify a pre-determined conclusion that all experts supported deferral. Oracle gave the architecture an A- specifically because "execution order suboptimal" with daemon too late.

### M2: Decision 2 oversimplifies AgentSdkAdapter complexity

**What decisions.md says**: "Momus rates AgentSdkAdapter at 50% success due to permission bridging complexity — but the insurance value justifies the investment."

**What Momus actually says**: The 50% success rate is for a 1500+ LOC async coordination nightmare including: pending Promise Map with timeout handling, cleanup on session close, error propagation, and race conditions. The decisions document frames this as a simple insurance policy, but Momus and Metis both classify it as "VERY HIGH" actual complexity.

The "insurance value" framing downplays the cost: if it's 50% likely to fail, you're spending 3 weeks on something that may never work. A true insurance policy should be cheap.

### M3: Decision 4 overstates the value of types-only mobile additions

**What decisions.md says**: "Adding `message_id` and `seq` to ConsumerMessage costs near-zero effort" and "Prevents breaking protocol changes when mobile/relay arrives later"

**What the Mobile Expert actually found**: Mobile readiness was graded C- (fixable to A-) requiring 3-4 weeks of work across reconnection protocol, pagination, push notifications, streaming throttle, and offline support. The types-only approach addresses approximately 5% of the actual mobile gap.

The Protocol Designer says: "Store all messages (including stream_event, tool_progress) in messageHistory, not just terminal ones" — this is architectural work, not type definitions.

### M4: Decision 5 selectively prioritizes security findings

**What decisions.md says**: Implement origin validation (1 day) + CLI auth tokens (1 week) + relay-ready auth interfaces (2 days)

**What the Security Expert recommends at P0**:
1. E2E encryption for relay [P0] — deferred (appropriate since relay is deferred)
2. **Message signing for permission responses [P0]** — **NOT INCLUDED** in "implement now"
3. **Encrypted session files at rest [P0]** — **NOT INCLUDED** in "implement now"
4. WebSocket origin validation [P0] — included

The Security Expert rates permission response signing and encrypted data at rest as P0 (same priority as origin validation), but the decisions document cherry-picks only the cheapest P0 items. Permission response spoofing (T2) is rated HIGH likelihood, HIGH impact — this is a real vulnerability for the library, not just the relay.

### M5: The "12-14 weeks" timeline contradicts expert estimates

**Decisions summary**: "12-14 weeks (1-2 engineers)"

**Expert estimates**:
- Momus: 10 weeks for Phases 1-5 (1 engineer, full-time) — but at 85% confidence with abort triggers
- Protocol Designer: 7-10 weeks for universal adapter layer alone
- Test Architect: 3-3.5 weeks for critical test infrastructure (parallel)
- Security Expert: 2-3 weeks for P0 security fixes
- Consolidated Review: 12 weeks with 1-2 engineers

The 12-14 week estimate MIGHT work with 2 engineers running test infra + security in parallel with adapter work. With 1 engineer, it's 16-20 weeks. The decisions document doesn't clarify the parallelism assumption.

---

## 3. MISSING DECISIONS

### MD1: UnifiedMessage design — CRITICAL

The consolidated review lists this as Cross-Expert Finding #2: "UnifiedMessage Does Not Exist Yet." The Protocol Designer calls it PRIORITY 1 and says it must be implemented BEFORE any adapter work.

**The decisions document never makes a decision about UnifiedMessage design.** It's assumed as part of Phase 1 but never addresses:
- Lowest-common-denominator vs. adapter-specific passthrough (the consolidated review lists this as Blocking Decision #2)
- How unknown message types from future adapters are handled
- Whether metadata escape hatch is included (Oracle recommends it)
- Schema versioning strategy

This is the foundational type that everything depends on. Not deciding its design is like not deciding the database schema.

### MD2: BackendSession interface splitting — HIGH

DX Designer's #1 recommendation is to split BackendSession into cohesive interfaces (Core + optional Interruptible, Configurable, PermissionHandler). Metis identifies the leaky abstraction (A1) and the Protocol Designer identifies the push/pull impedance mismatch (#3).

**The decisions document never addresses interface splitting.** It implicitly assumes the monolithic BackendSession will work.

### MD3: Backpressure handling — CRITICAL

Protocol Designer rates backpressure as CRITICAL MISSING (#5). Mobile Expert shows that 30 stream_events/sec causes thermal throttling. The consolidated review lists it as Cross-Expert Finding #6.

**The decisions document never mentions backpressure.** Not in the security section, not in the mobile readiness section, not anywhere.

### MD4: Contract testing strategy — HIGH

Test Architect says: "No contract testing framework exists. This is the HIGHEST PRIORITY test infrastructure investment." The consolidated review lists it as Finding #7.

**The decisions document has no testing decisions at all.** No mention of contract testing, test infrastructure investment, or testing strategy.

### MD5: Migration path for existing users — HIGH

DX Designer (Finding #9): "Breaking changes with no gradual path." Recommends 3-phase migration (v0.2 opt-in -> v0.3 deprecation -> v1.0 required).

**The decisions document doesn't address backward compatibility or migration.** The document is entirely forward-looking and ignores existing users.

### MD6: Error handling strategy — MEDIUM

Protocol Designer (#8): Error propagation is inconsistent. Some errors are silent, some visible, some drop connections. DX Designer: Needs error taxonomy.

**No decision on how adapters should handle and propagate errors.**

### MD7: Who owns subprocess spawning? — HIGH

Metis (B2): "Does SdkUrlAdapter own subprocess spawning (replaces CLILauncher)? Or only handle message translation?" This determines the ownership boundary between BackendAdapter and CLILauncher.

**Not decided.** This will become a blocking question in the first week of Phase 1.

---

## 4. DEPENDENCY CHAIN

### True Dependency Order

```
[MD1: UnifiedMessage Design] --blocks--> [Decision 2: Adapter Priority]
                                          [MD2: Interface Splitting]
                                          [MD3: Backpressure]
                                          [MD4: Contract Tests]

[Decision 6: Single Package] --independent (can be changed anytime)

[Decision 5: Security Quick Wins] --partially independent--
  |-- Origin validation: independent, do anytime
  |-- CLI auth tokens: blocks Phase 1 (Protocol Designer P1)
  +-- Auth interfaces: depends on Decision 1 (relay-aware design)

[Decision 1: Library First] --constrains--> [Decision 4: Mobile Readiness]
                                             [Decision 5: Security scope]

[Decision 3: PTY Strategy] --depends on--> [Decision 2: Adapter Priority]
  (PTY fills gaps in adapters, so adapter scope determines PTY scope)

[Decision 2: Adapter Priority] --blocked by--> [MD1: UnifiedMessage]
                                                [MD2: Interface Design]
                                                [MD7: Subprocess Ownership]
```

### Reversibility Assessment

| Decision | Reversible? | Cost of Reversal |
|----------|-------------|------------------|
| D1: Library First | YES — can add relay later | LOW (designed for this) |
| D2: Adapter Priority | PARTIALLY — can reorder, but can't easily remove one once built | MEDIUM |
| D3: PTY as Utility | YES — can promote to standalone later | LOW |
| D4: Mobile Types | YES — types are cheap to change before consumers exist | LOW |
| D5: Security Quick Wins | YES — can add more security later | LOW (but security debt accumulates) |
| D6: Single Package | YES — can split later per plan | MEDIUM (users must update imports) |

**Key insight**: All 6 decisions are reasonably reversible. The REAL risk is the missing decisions (MD1-MD7), which are harder to reverse once implementation begins because they become load-bearing assumptions in the code.

---

## 5. CONFIDENCE ASSESSMENT

### Decision 1: Library First, Relay-Aware
**Confidence: HIGH** (will survive implementation)
- Strong expert consensus for deferring relay
- "Relay-aware" adds minimal constraint if kept lightweight
- **Risk**: The "+1-2 weeks for relay-aware design" estimate is probably 2x optimistic, but the direction is correct
- **Caveat**: If Oracle is right about competitive timing, this decision may need revisiting in 3-6 months

### Decision 2: Adapter Priority — SdkUrl + ACP + AgentSDK
**Confidence: MEDIUM** (will survive with modifications)
- SdkUrlAdapter will succeed (it's extracting existing working code)
- ACPAdapter has 60% success per Momus — realistic for 3 weeks of effort
- AgentSdkAdapter has 50% success per Momus — may not ship in initial timeline
- **Likely outcome**: SdkUrl ships on time, ACP ships 1-2 weeks late, AgentSdk is cut or delayed
- **Risk**: The three-adapter scope may be reduced to two under timeline pressure

### Decision 3: PTY as Composable Utility
**Confidence: HIGH** (will survive implementation)
- Correct architectural choice — all experts agree standalone PTY adapter is too fragile
- Composable utility defers risk without closing options
- **Risk**: PTY utility may be less useful than hoped if ANSI parsing is too unreliable even for limited features

### Decision 4: Mobile Readiness — Protocol Types Only
**Confidence: LOW** (will survive but provide little value)
- The types themselves will be implemented, but they'll be revised when mobile work actually begins
- Types-only approach doesn't prevent breaking changes — it just creates an illusion of mobile readiness
- **Likely outcome**: Types ship, sit unused for months, then get redesigned when someone builds actual reconnection
- **Risk**: Creates false confidence that "mobile is handled" when it's not

### Decision 5: Security Quick Wins
**Confidence: MEDIUM** (will survive but is incomplete)
- Origin validation and CLI auth tokens will ship — they're straightforward
- **Missing**: Permission response signing (P0 per Security Expert) is a real gap
- **Risk**: Users will deploy on non-localhost without understanding the security implications. The library should emit warnings when `host !== '127.0.0.1' && !authenticator`, but this isn't mentioned
- **Likely outcome**: Quick wins ship, but a security incident on a non-localhost deployment forces an emergency patch for message signing

### Decision 6: Single Package
**Confidence: HIGH** (will survive implementation)
- Correct for current scale
- Clear future split plan
- YAGNI applied properly
- **Risk**: If a popular consumer only needs one adapter, install size complaints may force splitting earlier than planned

---

## EXECUTIVE SUMMARY

### The decisions document gets the BIG decisions right:
1. Library-first is correct (strong consensus)
2. Adapter priority order is reasonable
3. PTY as utility is correct
4. Single package is correct

### The decisions document has three critical gaps:
1. **UnifiedMessage design is not decided** — this blocks everything and is the single most important pre-implementation decision
2. **Backpressure handling is not addressed** — a critical protocol gap identified by multiple experts
3. **Permission response signing is omitted from security quick wins** — the Security Expert rates this P0

### The decisions document misrepresents one expert:
- Oracle's position on relay timing is softened from "move daemon to Phase 4" to "deferring is acceptable"

### The decisions document creates one illusion:
- Decision 4 (mobile types) creates a false sense of mobile readiness. The types-only approach addresses ~5% of the Mobile Expert's findings while claiming to "prevent breaking protocol changes."

### Recommended additions before implementation begins:
1. **Decide UnifiedMessage shape** (metadata escape hatch, unknown message handling, schema version)
2. **Decide BackendSession interface splitting** (monolithic vs. composed)
3. **Add backpressure to Phase 1 scope** (per-consumer send queues)
4. **Add permission response signing to security quick wins** (Security Expert P0)
5. **Decide subprocess ownership boundary** (adapter vs. CLILauncher)
6. **Add contract testing to Phase 1 prerequisites** (Test Architect's top recommendation)
