# Momus Validation Report: Architecture Decisions Review

**Status**: CONDITIONAL GO
**Reviewed**: `docs/architecture/decisions.md` against original Momus critique and consolidated review
**Method**: Week-by-week execution simulation against actual codebase (12,352 LOC, 7,006 LOC tests)

---

## 1. Timeline Reality Check — Week-by-Week Simulation

The decisions claim 12-14 weeks for 1-2 engineers. Here's what actually happens:

### Weeks 1-2: UnifiedMessage + BackendAdapter Interface Design
- **What happens**: You need to define `UnifiedMessage` first (consolidated review finding #2). This means analyzing all 10 CLIMessage variants, all 20+ ConsumerMessage variants, and designing a format that ACP and AgentSDK can also produce.
- **Hidden work**: `ConsumerMessage` directly imports `CLIAssistantMessage["message"]` and `CLIResultMessage` (consumer-messages.ts:18-26). These types are **structurally coupled** — you can't just swap them. Every consumer message that wraps a CLI type needs a new intermediate representation.
- **Realistic outcome**: 2 weeks for types + interface. This is the easy part.

### Weeks 3-5: SdkUrlAdapter Extraction (Phase 1)
- **What happens**: Extract current NDJSON/WebSocket logic from SessionBridge into SdkUrlAdapter.
- **The real problem**: SessionBridge is 1,283 LOC with **zero separation** between transport (NDJSON parsing, WebSocket sends), state management (session lifecycle, pendingPermissions), and business logic (message routing, permission resolution). You're not "extracting" — you're **splitting a monolith**.
- **Specific coupling points**:
  - `handleCLIMessage()` calls `parseNDJSON` directly (line 329)
  - `routeCLIMessage()` has a 10-branch switch that maps CLI types to consumer messages (lines 731-766)
  - `sendToCLI()` uses `serializeNDJSON` and appends `\n` (line 1197)
  - `handleResultMessage()` updates 8 different session state fields directly (lines 836-886)
  - Permission handling is bidirectional: CLI pushes requests, consumers respond, session tracks pending state
- **Test rewrite**: 7,006 LOC of tests assume SessionBridge IS the bridge. Every test that calls `handleCLIMessage` with raw NDJSON strings breaks when that responsibility moves to SdkUrlAdapter.
- **Realistic outcome**: 3-4 weeks. NOT 2 weeks. The Momus original estimate of "2-3 weeks" was accurate; the decisions doc's implied "included in 12-14 weeks" hides this.

### Weeks 6-7: SessionBridge Becomes Backend-Agnostic (Phase 2)
- **What happens**: SessionBridge consumes only UnifiedMessage.
- **The catch**: This is EASY only if Phase 1 succeeded cleanly. If the interface is wrong (abort trigger #1), this is where you discover it.
- **Realistic outcome**: 1 week. This is a cleanup phase, not new work.

### Weeks 8-10: ACPAdapter (Phase 3)
- **What happens**: JSON-RPC over stdio. Subprocess management, message correlation, capability negotiation.
- **Hidden complexity the decisions doc acknowledges but underestimates**:
  - ACP uses stdio (stdin/stdout), not WebSocket. This means spawning a child process, managing its lifecycle, handling crashes, and correlating JSON-RPC request/response pairs.
  - ACP's capability model doesn't map 1:1 to `BackendCapabilities`. You'll spend a week just figuring out which capabilities to expose vs. stub.
  - Testing requires a MockACPAgent. The consolidated review says 3-3.5 weeks for test infra. Where is this time budgeted?
- **Realistic outcome**: 3-4 weeks including test infrastructure.

### Weeks 11-13: AgentSdkAdapter (Phase 4)
- **The hardest adapter**: SDK uses callbacks (pull model) for permissions. Bridge broadcasts (push model). Momus originally rated this 50% success.
- **Specific problem**: The Anthropic Agent SDK's `onToolUse` callback returns a Promise that blocks the agent. The bridge needs to hold that Promise open while broadcasting `permission_request` to all consumers, then resolve it when ANY consumer responds. This requires:
  - A `Map<requestId, { resolve, reject, timeout }>`
  - Timeout handling (what if no consumer responds?)
  - Cleanup on session close (reject all pending)
  - Race condition management (two consumers respond simultaneously)
- **Current codebase already has a simpler version**: `pendingPermissions` Map in SessionBridge (line 55). But the SDK version is harder because the SDK controls the execution flow, not the bridge.
- **Realistic outcome**: 2-3 weeks, but with 60% confidence, not 90%.

### Week 14: Security Quick Wins (Decision 5)
- **WebSocket origin validation**: 1 day. This is literally adding an `origin` check in `node-ws-server.ts`. Trivial.
- **CLI auth tokens**: 1 week. Generate token, pass to `--sdk-url`, validate on connection. Straightforward.
- **Auth interfaces**: 2 days. Already partially done — `Authenticator` interface exists (interfaces/auth.ts).
- **Realistic outcome**: 1.5 weeks. This is the most accurately estimated item.

### Actual Timeline: 14-17 Weeks

| Phase | Decisions Doc | My Estimate | Gap |
|-------|--------------|-------------|-----|
| UnifiedMessage + interfaces | "included" | 2 weeks | Hidden |
| SdkUrlAdapter extraction | ~3 weeks | 3-4 weeks | +1 week |
| SessionBridge cleanup | ~1 week | 1 week | On target |
| ACPAdapter | ~3 weeks | 3-4 weeks | +1 week |
| AgentSdkAdapter | ~2-3 weeks | 2-3 weeks | On target |
| Security quick wins | ~2 weeks | 1.5 weeks | -0.5 weeks |
| Test infrastructure | Not budgeted | 2-3 weeks (parallel) | Hidden |
| **Total** | **12-14 weeks** | **14-17 weeks** | **+2-3 weeks** |

**Verdict**: 12-14 weeks is achievable ONLY if you have 2 engineers and the test infrastructure runs in parallel. With 1 engineer, 16-18 weeks is more honest.

---

## 2. "Relay-Aware" Tax

The decisions say "design for relay but don't build it" costs "+1-2 weeks." Let me audit each relay-aware item:

| Item | Claimed Cost | Actual Cost | Reason |
|------|-------------|-------------|--------|
| Serializable SessionBridge state | ~0 | 0 | Already done (file-storage.ts persists sessions) |
| Protocol message IDs + seq numbers | ~1 week | 2-3 days | Adding 3 fields to ConsumerMessage is trivial |
| Abstract consumer interface | ~0 | 1-2 days | WebSocketLike is already abstract (5 LOC) |
| Auth interfaces for JWT/mTLS | ~2 days | 2 days | Authenticator interface already exists |
| Reconnect/history protocol types | ~3 days | 3 days | Type definitions only, no implementation |

**Total relay-aware tax**: ~1.5 weeks. The "+1-2 weeks" estimate is accurate. This is NOT a 4-6 week tax.

**Why it's cheap**: The codebase already has the right abstractions (`WebSocketLike`, `Authenticator`, `SessionStorage`). The relay-aware design is mostly "don't break what's already there" plus "add some type definitions."

**Risk**: The real tax isn't in the types — it's in the **cognitive overhead**. Every design decision during Phase 1 will have someone asking "but what about relay?" This creates decision paralysis. Budget 0.5 weeks of wasted discussion time.

**True cost**: ~2 weeks. Decisions doc says 1-2 weeks. Close enough. **Tax is acceptable.**

---

## 3. Abort Trigger Validation

### Trigger 1: "Phase 1 takes > 3 weeks -> abstraction is wrong"

**Is it measurable?** YES, but the definition is ambiguous.

- Does "Phase 1" include UnifiedMessage design? If yes, 3 weeks is tight.
- Does "Phase 1" include test rewrite? If yes, 3 weeks is impossible.
- **Fix**: Define Phase 1 as "BackendAdapter interface compiles + SdkUrlAdapter passes **existing** integration tests." Test rewrite is separate.
- **My version**: Phase 1 is done when `session-bridge.integration.test.ts` passes with SdkUrlAdapter injected. Timebox: 3 weeks from first line of code (not from first design discussion).

### Trigger 2: "Permission coordination requires > 500 LOC -> too complex"

**Is it measurable?** YES, and it's the best trigger.

- Current permission handling in SessionBridge: ~120 LOC (handleControlRequest + handlePermissionResponse + sendPermissionResponse).
- SdkUrlAdapter permission handling: will be ~150 LOC (same logic, different location).
- AgentSdkAdapter permission handling: THIS is the risk. The Promise-to-broadcast bridge could easily hit 300+ LOC. Add timeout handling, cleanup, and race conditions: 400-500 LOC.
- **Danger**: 500 LOC for ONE adapter's permission code means the abstraction leaked. The BackendAdapter interface should absorb most of this complexity.
- **My assessment**: Tight but achievable. Expect 300-400 LOC for AgentSdkAdapter permissions. If it hits 500, the interface is wrong.

### Trigger 3: "Any adapter requires PTY fallback for basic messaging -> agent isn't ready"

**Is it measurable?** PARTIALLY.

- "Basic messaging" is undefined. Does it mean `send message + receive response`? Or does it include `permissions + interrupts + model switching`?
- **Fix**: Define "basic messaging" as: send user message, receive assistant messages, receive result. If ANY adapter can't do these three things without PTY, abort.
- **Risk**: ACP agents that don't implement `sampling/createMessage` properly will fail this. This is an external dependency you can't control.

**Overall trigger assessment**: Triggers 1 and 2 are good. Trigger 3 needs sharper definition. **Add a 4th trigger**: "UnifiedMessage type changes > 3 times during Phase 3-4 -> the abstraction is too Claude-Code-specific."

---

## 4. Scope Creep Vectors

### Vector 1: "Just one more adapter" (PROBABILITY: 90%)
Once ACP works for Goose, someone will say "let's add OpenCode, it's just REST." The decisions doc defers OpenCode, Codex, Gemini, and PTY standalone — but the moment the adapter pattern works, the temptation to add "one more" is overwhelming. Each adapter is "only 2-3 weeks."

**Mitigation**: Hard cap at 3 adapters for v1. No exceptions.

### Vector 2: "Consumer SDK" (PROBABILITY: 70%)
The decisions doc mentions a future `@claude-code-bridge/react` package. The moment consumers start using the WebSocket API directly, someone will build a React hook. Then someone will want types. Then someone will want a state manager. This is a separate project disguised as "DX improvement."

**Mitigation**: Ship raw WebSocket protocol. React hooks are a v2 concern.

### Vector 3: "Backpressure handling" (PROBABILITY: 60%)
The consolidated review (finding #6) mentions backpressure as a real problem. The decisions doc doesn't address it. Once mobile consumers connect, the "just ws.send() everything" approach will fail. Adding per-consumer send queues with high-water marks is 1-2 weeks of work that will feel urgent.

**Mitigation**: Accept the risk for v1 (localhost only). Block backpressure behind "relay" milestone.

### Vector 4: "Test infrastructure gold-plating" (PROBABILITY: 80%)
The test architect wants 3,500-7,000 tests. The consolidated review says 3-3.5 weeks for "critical path" test infra. This will expand. Contract tests, mock agents, integration test harnesses, CI matrix for different agent versions — each item is "just a day or two."

**Mitigation**: Contract tests for UnifiedMessage compliance only. No mock agents in v1. Test against real agents in CI nightly, not per-commit.

### Vector 5: "Protocol versioning" (PROBABILITY: 50%)
Adding `message_id` and `seq` to ConsumerMessage will trigger questions about versioning, backward compatibility, and migration. Someone will propose a `protocol_version` handshake. This is relay-adjacent work disguised as "good hygiene."

**Mitigation**: Version the protocol as part of the npm package version. No separate protocol version.

---

## 5. What Will Actually Ship in 14 Weeks

### Best Case (30% probability):
1. BackendAdapter interface with 3 implementations (SdkUrl, ACP, AgentSDK)
2. SessionBridge consuming UnifiedMessage
3. WebSocket origin validation + CLI auth tokens
4. Contract test suite
5. Protocol types for reconnection (types only)
6. npm package v0.2.0

### Likely Case (50% probability):
1. BackendAdapter interface with 2 implementations (SdkUrl + ACP)
2. SessionBridge consuming UnifiedMessage
3. WebSocket origin validation + CLI auth tokens
4. Basic test coverage (not full contract suite)
5. AgentSdkAdapter partially done, permission bridging incomplete
6. npm package v0.2.0-beta

### Worst Case (20% probability):
1. BackendAdapter interface with 1 implementation (SdkUrl)
2. SessionBridge partially decoupled
3. ACP adapter stalled on capability mapping disagreements
4. AgentSdkAdapter abandoned due to permission complexity
5. 4+ weeks spent on UnifiedMessage design churn
6. No release

**What WON'T ship regardless**:
- Relay/daemon (correctly deferred)
- Agent teams integration (correctly deferred)
- ACP server endpoint (correctly deferred)
- Standalone PTY adapter (correctly deferred)
- Consumer SDK / React hooks (not mentioned but will be requested)

---

## 6. Verdict: CONDITIONAL GO

The decisions document represents **good engineering judgment**. The original Momus report's recommendations were largely followed. The scope was cut appropriately. The relay-aware tax is acceptable. The decisions answer the 5 blocking questions raised in the consolidated review.

### Why CONDITIONAL GO (not full GO):

**Condition 1**: Fix the timeline. 12-14 weeks with 1 engineer is a lie. State 14-17 weeks with 1 engineer, or 12-14 weeks with 2 engineers where one focuses on test infrastructure.

**Condition 2**: Sharpen abort trigger #3. Define "basic messaging" as exactly: `send(string) -> AsyncIterable<UnifiedMessage>` producing at minimum `assistant` and `result` messages. No PTY for these three operations.

**Condition 3**: Add abort trigger #4. "UnifiedMessage type changes > 3 times during adapter implementation -> the type is wrong, stop and redesign."

**Condition 4**: Budget test infrastructure explicitly. The consolidated review says 3-3.5 weeks. The decisions doc says nothing. This WILL happen. Put it in the timeline or accept the likely-case outcome of "basic test coverage only."

**Condition 5**: Commit to 2 adapters as the realistic v1 target (SdkUrl + ACP), with AgentSdkAdapter as stretch goal. The decisions doc lists all 3 as in-scope. The likely outcome is 2. Plan for 2, celebrate if you get 3.

### What the original Momus got right:
- "Build the library. Ship it. Let others build the platform." -> The decisions followed this.
- "Cut Phases 6, 7, 8 entirely." -> The decisions followed this.
- "Phase 1 takes > 3 weeks -> abstraction is wrong." -> Adopted as-is.
- AgentSdkAdapter at 50% success -> Still true. The decisions acknowledge this but optimistically include it in scope.

### What the original Momus got wrong:
- "10 weeks" for the scoped work -> Too aggressive. 14-17 is more realistic given the test rewrite.
- "Conditional No-Go" -> Too harsh in retrospect. The decisions doc addressed every concern.

### Final Score:
- **Decisions quality**: 8/10 — well-reasoned, well-scoped, addresses expert feedback
- **Timeline realism**: 5/10 — 2-3 weeks too aggressive for the scope described
- **Abort trigger quality**: 7/10 — trigger 1 and 2 are good, trigger 3 needs work
- **Scope discipline**: 9/10 — excellent deferrals, minimal YAGNI violations remaining
- **Execution confidence**: 65% for likely-case outcome

**CONDITIONAL GO. Fix the conditions above. Then execute.**
