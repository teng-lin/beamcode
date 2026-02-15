# Momus Validation Report: Universal Adapter Layer RFC

**Status**: Conditional No-Go
**Verdict**: The plan is architecturally sound but operationally naive. 60% of the proposed work won't happen, 30% will fail, and 10% might succeed.

---

## 1. PLAN REALISM -- Execution Simulation

### Phase 1: Extract BackendAdapter + SdkUrlAdapter
**Claimed effort**: "Behavioral equivalence, all tests pass"
**Actual complexity**: HIGH

Three fundamental impedance mismatches:
1. **AsyncGenerator vs EventEmitter**: Incompatible execution models. Can't "just wrap" without buffering, backpressure, and cancellation semantics.
2. **Push vs Pull permissions**: Bridge broadcasts (push), SDK uses callback returning Promise (pull). Requires Map of pending Promises with race condition management.
3. **Message history vs live streaming**: Bridge maintains `messageHistory` for replay. `BackendSession.messages()` only produces future events.

**Reality check**: 2-3 weeks of refactoring, not "behavioral equivalence."
**Probability of success**: 70%

### Phase 2: SessionBridge Becomes Backend-Agnostic
**Claimed effort**: "Remove all NDJSON parsing"
**Actual impact**: MINIMAL -- this is a no-op if Phase 1 succeeded.
**Probability of success**: 90%

### Phase 3: ACPAdapter -- The Strategic Bet
**Claimed**: "Single adapter covers 25+ agents"
**Reality**: You get 5-6 agents, not 25+. Most "ACP support" is vaporware or community adapters.

ACP capability model is incomplete -- doesn't include modelSwitching, permissionModeSwitchingMidSession, sessionFork, costTracking, agentTeams. You'll maintain agent-specific capability mappings, defeating the universal adapter purpose.

**The real work**: 2000+ LOC for ACP stdio subprocess management, JSON-RPC correlation, session lifecycle, error handling.
**Probability of success**: 60%

### Phase 4: AgentSdkAdapter -- The Callback Hell
**Actual complexity**: VERY HIGH

SDK permission model blocks agent until callback returns. Bridge broadcasts to all consumers asynchronously. Bridging requires pending Promise Map with timeout handling, cleanup on session close, error propagation, and race conditions.

**The real work**: 1500+ LOC of async coordination.
**Probability of success**: 50%

### Phase 5: OpenCodeAdapter
**Actual problem**: WHO STARTS THE SERVER? OpenCode requires `opencode serve` running. Need process management, health checks, circuit breakers.
**Probability of success**: 80%

### Phase 6: ACP Server Endpoint -- Architecture Confusion
ACP server (stdio JSON-RPC) and WebSocket server are mutually exclusive deployment modes. Can't do both in same process. Needs two separate entry points.
**Probability of success**: 40%

### Phase 7: Agent Teams Integration -- File Watching is Not Real-Time
File watching problems: polling delay (10-100ms), event coalescing, ordering, missing events, cross-platform differences. Hook events need second HTTP server.
**Probability of success**: 30%

### Phase 8: Daemon + Relay Layer -- Separate Project
**Actual scope**: 5000+ LOC, 3 months of work. This is not "one phase."
**Probability of success**: 10% (will get deprioritized)

### Phase 9: PTY Adapter
Breaks every time CLI updates output format. Should be 100 LOC of "spawn, stream, pray."
**Probability of success**: 70% (trivial cases only)

---

## 2. HIDDEN EFFORT

### Easy (but looks hard):
- NDJSON parsing -> UnifiedMessage translation (200 LOC)
- OpenCode REST client (300 LOC)
- Session persistence (already done)

### Hard (but looks easy):
- AsyncGenerator bridging (500 LOC, 1 week)
- Permission coordination (300 LOC, 3 days)
- ACP capability mapping (ongoing maintenance)
- Process supervision (1000 LOC, 2 weeks)
- File watching (400 LOC, 1 week)

### Extremely Hard (RFC handwaves):
- Daemon state machine (1500 LOC, 1 month)
- Relay routing with E2E encryption (2000 LOC, 6 weeks)
- Hook coordination without HTTP server (500 LOC, 2 weeks)

---

## 3. PHASE COUPLING

The RFC claims phases can run independently. **This is false.**

```
Phase 1 -> BLOCKS -> Phase 2, 3, 4, 5
Phase 2 -> BLOCKS -> Phase 6
Phase 7 -> REQUIRES -> Phase 8 (for hook HTTP server)
Phase 8 -> REQUIRED BY -> Phase 9 (process supervision)
```

Only truly independent: Phase 3, 4, 5, 9 (different adapters) -- BUT all need Phase 1 first.

**Reality**: Linear sequence with 2-3 parallel tracks at most.

---

## 4. MVP IDENTIFICATION

**Smallest proof of thesis:**
Phase 1 + Phase 2 + ONE adapter (Phase 3 or 4)

**Deliverables:**
1. BackendAdapter interface that compiles
2. SdkUrlAdapter that passes existing tests
3. One new adapter (ACPAdapter for Goose OR AgentSdkAdapter)
4. SessionBridge consumes BackendSession.messages()

**Effort**: 4-6 weeks
**Outcome**: Proves adapter pattern is viable. If this fails, entire RFC fails.

---

## 5. BLOCKING QUESTIONS -- Disguised Decisions

- **Q1 "Separate npm packages?"** = Do we accept monorepo complexity? Decision needed before Phase 1.
- **Q2 "Adapter-specific features?"** = Do we accept lowest-common-denominator? Decision needed before Phase 2.
- **Q3 "Relay in this project?"** = What's the scope boundary? Decision needed before Phase 8.
- **Q6 "ACPAdapter as default?"** = Are we deprecating custom adapters? Decision needed before Phase 3.
- **Q9 "Daemon in bridge or separate?"** = Is this a library or daemon? Decision fundamentally changes the product.

---

## 6. YAGNI VIOLATIONS

- **Session fork** (9/10): Only OpenCode/Codex support it, no UI exists
- **Agent teams dashboard** (8/10): Experimental feature, file-based coordination wrong for real-time
- **Multi-consumer presence** (7/10): Solving a non-problem (who co-watches coding sessions?)
- **7 different adapters** (7/10): 90% of users will use Claude Code. Build 2, not 7.
- **Relay E2E encryption** (6/10): SSH+tmux already provides this

---

## 7. FRAGILITY ANALYSIS

- **Claude Code --sdk-url**: UNOFFICIAL, UNDOCUMENTED. HIGH risk.
- **ACP Spec**: DRAFT, RAPIDLY EVOLVING. MEDIUM risk.
- **Agent SDK**: OFFICIAL, STABLE API. LOW risk.
- **OpenCode API**: OFFICIAL, OPENAPI SPEC. LOW risk.
- **PTY Fallback**: TERMINAL OUTPUT PARSING. EXTREME risk.

---

## 8. GO/NO-GO DECISION

### CONDITIONAL GO -- Only if:

**Preconditions:**
1. Cut Phases 6, 7, 8 entirely. Focus on adapter pattern only.
2. MVP first: Phase 1-2 + ONE adapter. Ship. Measure.
3. Answer Q1, Q2, Q6 before writing code.
4. 1 engineer, 3 months, full-time.

**Abort triggers:**
1. Phase 1 takes > 3 weeks -> abstraction is wrong
2. Permission coordination requires > 500 LOC -> too complex
3. Any adapter requires PTY fallback -> agent isn't ready

### NO-GO if:
1. You expect all 9 phases to ship
2. You want daemon + relay in this iteration
3. You don't have 3 dedicated months

---

## 9. WHAT DESERVES PRAISE

- RFC is exceptionally well-researched (30+ projects surveyed)
- Adapter pattern is architecturally sound
- Current codebase is excellent (12k LOC, well-tested, clean)
- ACP as strategic bet is correct
- Core insight is valuable: "No reusable library exists for CLI-to-frontend boundary"

**But:** The RFC confuses "library" with "platform."
- Library (BackendAdapter interface) -- YES, build this
- Daemon (process supervision) -- NO, separate project
- Relay (WebSocket proxy) -- NO, separate project
- Dashboard (agent teams UI) -- NO, frontend concern

**Build the library. Ship it. Let others build the platform.**

---

## FINAL VERDICT

**Conditional Go** for Phases 1-5 only.

**What you'll actually ship (10 weeks):**
- Phase 1-2: BackendAdapter + SdkUrlAdapter (4 weeks)
- Phase 4: AgentSdkAdapter (3 weeks)
- Phase 3: ACPAdapter (3 weeks)

**What you'll defer:** OpenCode, Codex, Gemini, PTY, Daemon, Relay, Agent teams, ACP server

**Confidence**: 85%
**Recommended next step**: Write Phase 1 implementation plan with explicit acceptance criteria.
