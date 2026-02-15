# Decision Review Panel — Synthesized Findings

**Date**: 2026-02-15
**Reviewers**: Metis, Momus, Devil's Advocate, Implementation Validator, Consistency Checker
**Document Reviewed**: `docs/architecture/decisions.md`

---

## Verdict: CONDITIONAL GO

All 5 reviewers agree the decisions are **directionally sound** but have gaps that need resolution before implementation begins.

---

## Cross-Expert Consensus (flagged by 3+ reviewers)

### 1. UnifiedMessage Design is the Critical Missing Decision

Every reviewer flagged this. The consolidated review called it "Finding #2", the consistency checker calls it "Decision 0", and Momus says it blocks everything. No decision addresses its shape, versioning, metadata escape hatch, or unknown message handling. This must be resolved first.

### 2. Timeline is 15-20% Optimistic

- Decisions doc claims: 12-14 weeks (1-2 engineers)
- Momus validated: 14-17 weeks (1 engineer), or 12-14 weeks (2 engineers with parallel test infra)
- Impl Validator: 14-18 weeks due to BackendAdapter extraction complexity
- Key gap: test infrastructure not budgeted (~3 weeks)

### 3. Decision 2 (SdkUrl Primary) is the Highest-Risk Choice

- Devil's Advocate rates it **CRITICAL** — 55% reversal likelihood, VERY HIGH reversal cost
- Building on an unofficial, undocumented flag that Anthropic can remove anytime
- Metis: maintaining TWO Claude Code adapters (SdkUrl + AgentSdk) if both ship is unsustainable

### 4. AgentSdkAdapter Should Be Stretch Goal, Not In-Scope

- Momus: "Commit to 2 adapters (SdkUrl + ACP), AgentSdkAdapter as stretch goal"
- 50% success probability for permission bridging (Promise-to-broadcast pattern)
- Likely outcome: 2 adapters ship, 3rd is partial

---

## What's Already Done (Pleasant Surprises)

| Item | Status | Source |
|------|--------|--------|
| Auth interfaces | Already relay-ready (`Authenticator` + `AuthContext`) | Impl Validator |
| PTY strategy | Already 80% implemented as `PtyCommandRunner` | Impl Validator |
| Serializable state | `PersistedSession` + `FileStorage` with WAL pattern | Impl Validator |
| NDJSON parsing | Clean, generic utilities with no coupling to CLIMessage | Impl Validator |
| WebSocketLike abstraction | Minimal interface (`send`/`close` only) | Impl Validator |

**Decision 5's "relay-ready auth interfaces" costs 0 additional effort.**
**Decision 3 is mostly packaging existing code.**

---

## What's Harder Than Expected

| Item | Why | Source |
|------|-----|--------|
| SessionBridge extraction | "God object" at 1,283 LOC with 12 tightly-coupled message handlers | Impl Validator |
| SessionState generalization | Fields specific to `--sdk-url` protocol (`claude_code_version`, `mcp_servers`, etc.) | Impl Validator |
| CLILauncher extraction | Tightly coupled to `--sdk-url` args; needs `BackendLauncher` interface | Impl Validator |
| Event map generalization | `cli:connected` must become `backend:connected` with adapter metadata | Impl Validator |
| Import path migration | If D6 restructuring happens, every file needs import updates (56 .ts files) | Impl Validator |
| Remote capability degradation | PTY features won't work over relay; protocol needs availability modes | Consistency Checker |
| Reconnection auth flow | `reconnect` message type has no auth field; D4 and D5 uncoordinated | Consistency Checker |

---

## Key Tensions Between Decisions

| Tension | Severity | Decisions | Issue |
|---------|----------|-----------|-------|
| AgentSdkAdapter may need PTY for permissions | **HIGH** | D2 + D3 | Triggers abort condition if true |
| Protocol types untestable without conformance tests | **HIGH** | D1 + D4 | "Relay-aware" design is aspirational without tests |
| PTY features unavailable to remote clients | **HIGH** | D3 + D4 | Silent feature gap for mobile consumers |
| Reconnection auth flow unspecified | MODERATE | D4 + D5 | Types incomplete without auth model |
| Security scoped to SdkUrl only | MODERATE | D2 + D5 | ACP and AgentSDK have different threat models |
| Single package bundles all adapter dependencies | LOW | D2 + D6 | Users who want one adapter get all dependencies |

---

## Risk Summary (Devil's Advocate)

| Decision | Reversal Likelihood | Reversal Cost | Danger Rating |
|----------|-------------------|---------------|---------------|
| 1. Library First | 40% | HIGH | MEDIUM-HIGH |
| 2. SdkUrl Primary | 55% | VERY HIGH | **CRITICAL** |
| 3. PTY Composable | 30% | LOW | LOW |
| 4. Protocol Types | 60% | LOW-MEDIUM | MEDIUM |
| 5. Security Quick Wins | 25% | LOW | LOW |
| 6. Single Package | 70% | MEDIUM-HIGH | MEDIUM |

**Most Dangerous**: Decision 2 — building on an unofficial, undocumented API flag.
**Safest**: Decision 3 — robust regardless of outcome, already 80% implemented.

---

## Momus Conditions for GO

1. **Fix the timeline**: 14-17 weeks (1 engineer) or 12-14 weeks (2 engineers with parallel test infra)
2. **Sharpen abort trigger #3**: Define "basic messaging" as `send(string) -> AsyncIterable<UnifiedMessage>` producing `assistant` and `result` messages
3. **Add abort trigger #4**: "UnifiedMessage type changes > 3 times during adapter implementation -> the type is wrong, stop and redesign"
4. **Budget test infrastructure**: ~3 weeks (parallel track)
5. **Scope AgentSdkAdapter as stretch goal**: Commit to 2 adapters (SdkUrl + ACP), celebrate if you get 3

---

## Recommended Additions Before Implementation

| Priority | Action | Source |
|----------|--------|--------|
| **P0** | Decide UnifiedMessage shape (metadata, unknown messages, versioning) | All 5 reviewers |
| **P0** | Decide BackendSession interface splitting (monolithic vs composed) | Metis, Consistency Checker |
| **P1** | Fix timeline to 14-17 weeks (1 eng) or 12-14 weeks (2 eng) | Momus, Impl Validator |
| **P1** | Scope AgentSdkAdapter as stretch goal | Momus |
| **P1** | Budget test infrastructure explicitly (~3 weeks) | Momus, Metis |
| **P2** | Add abort trigger #4: "UnifiedMessage changes >3x during adapter work" | Momus |
| **P2** | Sharpen abort trigger #3: define "basic messaging" precisely | Momus |
| **P2** | Add capability availability mode to protocol (local/remote/both) | Consistency Checker |
| **P2** | Decide subprocess ownership boundary (adapter vs CLILauncher) | Metis |
| **P3** | Add permission response signing to security scope | Metis |
| **P3** | Address adapter-specific security for ACP and AgentSDK | Consistency Checker |

---

## Likely Outcome (50% probability per Momus)

1. BackendAdapter interface with 2 implementations (SdkUrl + ACP)
2. SessionBridge consuming UnifiedMessage
3. WebSocket origin validation + CLI auth tokens
4. Basic test coverage (not full contract suite)
5. AgentSdkAdapter partially done, permission bridging incomplete
6. npm package v0.2.0-beta

---

## Individual Report References

| Reviewer | Report | Key Finding |
|----------|--------|-------------|
| Devil's Advocate | [devils-advocate.md](./devils-advocate.md) | D2 is most dangerous (55% reversal) |
| Metis | [metis.md](./metis.md) | 7 missing decisions, Oracle misrepresented |
| Momus | [momus.md](./momus.md) | CONDITIONAL GO, 14-17 weeks realistic |
| Impl Validator | [impl-validator.md](./impl-validator.md) | PTY 80% done, auth already relay-ready |
| Consistency Checker | [consistency-checker.md](./consistency-checker.md) | 3 HIGH tensions, correct phase order |
