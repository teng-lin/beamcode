# Consolidated Review: Universal Adapter Layer RFC

**Review Panel**: 8 experts | **Date**: 2026-02-15 | **Document**: `docs/architecture/universal-adapter-layer.md`

---

## Panel Verdicts

| Expert | Role | Grade | Verdict |
|--------|------|-------|---------|
| **Oracle Strategist** | Strategic Advisor | A- | Proceed; reprioritize daemon to Phase 4 |
| **DX Designer** | API/DX Specialist | Approve w/ conditions | Proceed with caution; DX investment needed |
| **Test Architect** | Testing Strategy | Highly testable | Proceed; contract testing infrastructure critical |
| **Protocol Designer** | Protocol Specialist | B+ / C | Architecture sound, implementation not ready |
| **Mobile Expert** | Mobile Developer | C- (fixable to A-) | Significant mobile enhancements needed |
| **Security Expert** | Security Architect | Conditional | DO NOT deploy relay without E2E encryption |
| **Metis Analyst** | Pre-planning Consultant | 8/10 overall | 23 issues found; top 3 are architectural risks |
| **Momus Critic** | Ruthless Reviewer | Conditional No-Go | Cut to Phases 1-5; build library, not platform |

**Consensus**: Architecture is fundamentally sound. Execution plan needs major scoping reduction and reprioritization.

---

## Top 10 Cross-Expert Findings

### 1. BackendSession Abstraction is Leaky (Metis, Protocol, DX)

**The problem**: The BackendSession interface bundles 6 concerns (streaming, control, introspection, lifecycle, permissions, extended features) into 15+ methods. The permission model mismatch between SDK (pull/callback) and bridge (push/broadcast) creates race conditions.

**Evidence**:
- Metis A1: "The abstraction will leak. AgentSdkAdapter needs to store pending Promises and resolve them when respondToPermission() is called"
- Protocol #3: Promise-to-Message bridging pattern not documented in RFC
- DX #2: "15+ methods on BackendSession creates steep learning curve"

**Recommendation**: Split into cohesive interfaces (`BackendSession` core + optional `Interruptible`, `Configurable`, `PermissionHandler`). Document Promise-to-Message bridging as first-class pattern.

---

### 2. UnifiedMessage Does Not Exist Yet (Protocol, Metis, DX)

**The problem**: The RFC defines `UnifiedMessage` as the core abstraction, but the codebase uses `CLIMessage` and `ConsumerMessage` with direct translation. No intermediate unified format exists.

**Evidence**:
- Protocol #1: "The proposed UnifiedMessage type doesn't exist in the codebase yet"
- Protocol #2: Translation loss documented across 6+ fields
- DX #11: "UnifiedMessage union unwieldy (15+ variants)"

**Recommendation**: Implement UnifiedMessage before any adapter work. Make adapters produce it, SessionBridge consume it. This is the foundation everything else depends on.

---

### 3. Phase 8 (Daemon + Relay) is a Separate Project (Momus, Metis, Oracle, Security)

**The problem**: The daemon/relay layer is 50% of the total project scope, disguised as a single phase. It requires distributed systems expertise, E2E encryption, process supervision, and relay infrastructure.

**Evidence**:
- Momus: "5000+ LOC, 3 months of work. This is not 'one phase.' Probability of success: 10%"
- Metis S1: "Not a refactoring phase -- it's greenfield development"
- Security: "DO NOT deploy relay/daemon features until E2E encryption complete"
- Oracle: Recommends moving daemon to Phase 4 but acknowledges it's the hardest part

**Recommendation**: Separate daemon/relay into a follow-on project. Focus the current RFC on the adapter abstraction layer only. Use Cloudflare Tunnel as interim relay if needed.

---

### 4. No Reconnection Protocol (Mobile, Protocol)

**The problem**: No WebSocket reconnection strategy exists. Mobile clients lose connections during WiFi/cellular handoff, background/foreground transitions, and brief signal loss.

**Evidence**:
- Mobile #2: "iOS WebSocket suspended after 30s background. Android after 60s. Reconnection required on every app switch"
- Protocol #9: "No Consumer ↔ Bridge keep-alive. WebSocket has no ping/pong in current code"
- Mobile: Load time for 1000+ message replay = 4.2s on LTE

**Recommendation**: Add message IDs and sequence numbers. Implement reconnect protocol with last-seen-message cursor. Add WebSocket ping/pong. Paginate message history (50 messages per page).

---

### 5. Security Fundamentals Missing for Remote Access (Security, Protocol)

**The problem**: Multiple security gaps make remote access unsafe: no E2E encryption for relay, no message signing for permissions, no WebSocket origin validation, no CLI authentication, plaintext data at rest.

**Evidence**:
- Security T1: "Man-in-the-Middle on Relay Connection [CRITICAL]"
- Security T2: "Permission Request Spoofing [HIGH] - NO message signing"
- Security T8: "WebSocket Origin Validation Missing [HIGH] - CSRF attacks"
- Protocol #11: "No CLI authentication - any localhost process can connect"
- Security T5: "Sessions stored as plaintext JSON"

**Recommendation**: Fix P0 security issues before any remote access work:
1. WebSocket origin validation (1 day)
2. Permission response message signing (1 week)
3. CLI authentication tokens (1 week)
4. E2E encryption (blocking for relay)

---

### 6. Backpressure Handling Missing (Protocol, Mobile)

**The problem**: No backpressure mechanism exists. The bridge broadcasts to all consumers via fire-and-forget `ws.send()`. A slow consumer (mobile on 3G) causes TCP backpressure that throttles all consumers.

**Evidence**:
- Protocol #5: "WebSocketLike interface has no pause(), resume(), drain events"
- Mobile #5: "30 stream_events/sec causes thermal throttling on iPhone 12"
- Mobile #10: "All consumers receive ALL message types. No filtering"

**Recommendation**: Implement per-consumer send queues with high-water marks. Add server-side streaming modes (full/throttled/final_only). Add message type filtering (set_message_filter) to reduce mobile bandwidth by up to 98%.

---

### 7. Contract Testing Infrastructure Critical (Test, Metis)

**The problem**: With 7+ adapters all producing UnifiedMessage, there's no way to ensure protocol compatibility. No contract testing framework exists.

**Evidence**:
- Test Architect: "No contract testing framework exists. This is the HIGHEST PRIORITY test infrastructure investment"
- Test Architect: "7 adapters x 500-1000 test cases = 3500-7000 total tests needed"
- Metis P2: "If BackendAdapter interface is wrong, ALL adapters are blocked"

**Recommendation**: Build contract test suite before implementing Phase 3+ adapters. Create MockACPAgent for CI testing. Estimated investment: 3-3.5 weeks for critical path (contract tests + mock agents).

---

### 8. ACP Agent Count Overstated (Momus, Oracle)

**The problem**: The RFC claims "single adapter covers 25+ agents" via ACP, but this is optimistic.

**Evidence**:
- Momus: "You get 5-6 agents, not 25+. Most 'ACP support' is vaporware or community adapters"
- Momus: "ACP capability model is incomplete - doesn't include modelSwitching, permissionModeSwitchingMidSession, sessionFork, costTracking"
- Oracle: Still recommends ACP-first strategy but for different reasons (strategic leverage, not coverage)

**Recommendation**: Target 5-6 confirmed ACP agents (Goose, Kiro, Gemini CLI). Design adapter for confirmed capabilities, not aspirational ones. Accept that agent-specific capability mappings will be needed.

---

### 9. Migration Path Missing (DX, Protocol)

**The problem**: Existing users face breaking changes with no gradual path. The RFC is a roadmap, not a reflection of current state.

**Evidence**:
- DX #9: "Breaking changes with no gradual path"
- Protocol conclusion: "Gap between RFC vision and codebase is significant but not insurmountable"
- DX #10: "Biggest UX gap: How does a user select which adapter?"

**Recommendation**: 3-phase migration:
1. v0.2: Add adapter support, keep old API as default (opt-in)
2. v0.3: Deprecation warnings if adapter not provided
3. v1.0: Require explicit adapter selection

Provide explicit configuration: `new SessionManager({ adapter: new ACPAdapter({...}) })`.

---

### 10. Agent Teams File-Based Coordination is Wrong Abstraction (Metis, Momus, Security)

**The problem**: File watching for real-time dashboards has platform-specific quirks, race conditions, polling delays, and security concerns. The file-based approach doesn't scale to remote access.

**Evidence**:
- Metis A7: "File watchers have platform-specific quirks. Race conditions on simultaneous writes"
- Metis F2: "File-lock-based coordination breaks on NFS"
- Momus YAGNI: "Experimental feature, file-based coordination wrong for real-time"
- Security T4: "Race condition in task claiming"
- Security T6: "No message authentication code on inbox files"

**Recommendation**: Defer agent teams integration. If pursued, use webhooks/HTTP instead of file polling. Add HMAC signatures to inbox messages. Use SQLite WAL mode instead of JSON files for ACID guarantees.

---

## Scope Recommendations

### Expert Consensus on Phases

| Phase | Oracle | Momus | Metis | Security | Protocol | Mobile | DX | Test |
|-------|--------|-------|-------|----------|----------|--------|-----|------|
| 1-2: Adapter Extraction | GO | GO | GO | GO | GO | - | GO | GO |
| 3: ACPAdapter | GO | GO | GO | - | GO | - | - | GO (after contract tests) |
| 4: AgentSdkAdapter | GO | GO | Risky | - | Risky | - | - | GO |
| 5: OpenCodeAdapter | GO | GO | GO | - | - | - | - | - |
| 6: ACP Server | Defer | NO | NO | - | Risky | - | - | - |
| 7: Agent Teams | Defer | NO | NO | Risky | - | - | - | - |
| 8: Daemon + Relay | Phase 4* | NO | NO | BLOCK | - | Needs work | - | - |
| 9: PTY Adapter | Low | Low | Low | - | - | - | - | - |

*Oracle wants daemon earlier for mobile differentiation; all others say defer or block.

### Recommended MVP Scope (10-12 weeks)

**Phase 1**: Extract BackendAdapter + SdkUrlAdapter (3-4 weeks)
- Implement UnifiedMessage type
- Implement backpressure handling
- Add CLI authentication tokens
- Add WebSocket origin validation
- Build contract test suite + MockACPAgent

**Phase 2**: SessionBridge becomes backend-agnostic (1 week)
- Remove all NDJSON parsing from bridge
- Bridge consumes only UnifiedMessage

**Phase 3**: ACPAdapter (3 weeks)
- Target Goose, Kiro, Gemini CLI
- ACP stdio subprocess management + JSON-RPC correlation
- Contract test compliance

**Phase 4**: AgentSdkAdapter OR OpenCodeAdapter (2-3 weeks)
- Pick ONE based on user demand
- Document Promise-to-Message bridging pattern

### Deferred (Separate Projects)

- Daemon + Relay → Separate project after adapter layer ships
- Agent Teams Dashboard → Separate project, needs architectural rethink
- ACP Server Endpoint → After ACP client is proven
- PTY Adapter → Community contribution or last resort

---

## Blocking Decisions Required Before Phase 1

1. **Monorepo vs separate packages?** (DX, Momus)
   - Decision determines build tooling, versioning strategy, import paths
   - Recommendation: Monorepo with `@claude-code-bridge/core` + `@claude-code-bridge/adapter-*`

2. **Adapter-specific features: passthrough or lowest-common-denominator?** (Momus, Metis)
   - Decision determines UnifiedMessage complexity and adapter author burden
   - Recommendation: Lowest-common-denominator + metadata escape hatch

3. **Is ACPAdapter the default?** (Momus)
   - Decision determines deprecation strategy for current --sdk-url approach
   - Recommendation: SdkUrlAdapter remains default; ACP is opt-in

4. **Minimum viable backend capability baseline** (Metis)
   - What MUST all adapters support?
   - Recommendation: messages, send, close, interrupt. Everything else optional via capability flags.

---

## Risk Matrix

| Risk | Likelihood | Impact | Owner | Mitigation |
|------|-----------|--------|-------|------------|
| Phase 1 takes > 3 weeks | Medium | HIGH (abort trigger) | Engineering | Timeboxed spike first |
| ACP spec breaking changes | 40% | HIGH | Engineering | Version lock, multi-version support |
| Permission coordination > 500 LOC | Medium | HIGH (abort trigger) | Engineering | Spike permission bridging first |
| Relay deployed without encryption | Low (if blocked) | CRITICAL | Security | Hard gate in CI/CD |
| Adapter explosion (scope creep) | 70% | CRITICAL | Product | Limit to 3 deep adapters |
| UnifiedMessage versioning conflicts | 50% | MEDIUM | Engineering | Semver, backward-compatible additions |

---

## Investment Summary

| Area | Effort | Priority |
|------|--------|----------|
| Core adapter layer (Phases 1-4) | 10-12 weeks | IMMEDIATE |
| Test infrastructure | 3-3.5 weeks (parallel) | IMMEDIATE |
| Security hardening (P0 issues) | 2-3 weeks (parallel) | IMMEDIATE |
| DX improvements (docs, migration) | 2-3 weeks | Before v1.0 |
| Mobile enhancements | 3-4 weeks | Before mobile launch |
| Daemon + Relay | 3+ months | SEPARATE PROJECT |

**Total for MVP**: ~12 weeks with 1-2 engineers, shipping adapter layer + 2-3 adapters + security hardening.

---

## Individual Reports

| Expert | Report |
|--------|--------|
| Oracle Strategist | [oracle-strategist.md](./oracle-strategist.md) |
| DX Designer | [dx-designer.md](./dx-designer.md) |
| Test Architect | [test-architect.md](./test-architect.md) |
| Protocol Designer | [protocol-designer.md](./protocol-designer.md) |
| Mobile Expert | [mobile-expert.md](./mobile-expert.md) |
| Security Expert | [security-expert.md](./security-expert.md) |
| Metis Analyst | [metis-analyst.md](./metis-analyst.md) |
| Momus Critic | [momus-critic.md](./momus-critic.md) |
