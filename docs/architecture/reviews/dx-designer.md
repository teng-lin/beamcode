# API/DX Designer Review: Universal Adapter Layer RFC

## Executive Summary

The proposed architecture is **strategically sound** but has **significant DX friction points**. The BackendAdapter/BackendSession interface is well-designed and SDK-aligned, but needs attention to ergonomics, discoverability, and migration path.

**Key Concerns:**
- Interface complexity: 15+ methods on BackendSession creates steep learning curve
- Configuration discovery: No clear answer to "How does a user select which adapter?"
- Type explosion: UnifiedMessage has 15+ union members
- Migration cliff: Existing users face breaking changes with no gradual path
- Packaging unclear: Monorepo vs separate packages undecided

**Verdict:** Proceed with caution. Architecture correct, DX investment needed.

---

## 1. Factory Pattern: createSession() / resumeSession()

**Assessment: Good, with minor improvements**

Strengths: Familiar to SDK users, async creation allows negotiation, create/resume semantically clear.

Weaknesses: No builder pattern for complex initialization, no adapter-specific options escape hatch.

**Recommendation:** Add optional builder pattern for advanced use cases. Keep current factory as primary interface.

---

## 2. Interface Size: BackendSession has 15+ methods

**Assessment: Too large; should split**

BackendSession bundles 6 concerns: streaming, control flow, introspection, lifecycle, permissions, extended features.

**Recommendation:** Split into cohesive interfaces with composition:
- Core: `BackendSession` (messages, send, close) -- required
- Optional: `Interruptible`, `Configurable`, `Introspectable`, `PermissionHandler`, `ExtendedFeatures`
- Type guards: `isInterruptible(session)` for capability detection

**Benefits:** Reduces adapter author burden by 60%, easier testing, clear separation.

---

## 3. SessionOptions: Defaults and semantics

**Assessment: Good defaults, unclear semantics**

Issues: Unclear which fields are adapter-specific, no validation on unsupported options, no adapter hints.

**Recommendation:** Adapters declare supported options via capabilities. Add validation helper for early failure.

---

## 4. Error Handling

**Assessment: Underspecified; needs error taxonomy**

Missing: Error taxonomy, recovery guidance, structured errors (just `message: string`).

**Recommendation:** Add error codes (`CONNECTION_LOST`, `INVALID_MODEL`, etc.), `retryAfter` for rate limits, structured context payloads.

---

## 5. AsyncIterable

**Assessment: Excellent choice, with one gotcha**

Perfect for streaming. Gotcha: multi-consumer semantics undefined. Need to document that each `messages()` call returns independent iterable with fan-out (not round-robin).

---

## 6. Consumer Protocol

**Assessment: Simple but lacking guidance**

Missing: No TypeScript SDK for consumers, no consumer documentation in RFC, no connection state machine documented.

**Recommendation:**
1. Document consumer connection flow in RFC
2. Provide `@claude-code-bridge/client` (vanilla TS)
3. Provide `@claude-code-bridge/react` (React hooks)

---

## 7. npm Packaging

**Assessment: Critical undecided question**

**Recommendation: Hybrid with plugin architecture**
- `@claude-code-bridge/core` (lean)
- `@claude-code-bridge/adapter-*` (plugins)
- `claude-code-bridge` (meta-package for backward compat)

---

## 8. Documentation

**Assessment: Severely lacking**

1780 lines of architecture analysis, zero lines of "How to write an adapter."

**Needed:**
- Getting started guide
- Reference adapter (heavily commented)
- Testing guide, error handling patterns, performance guide
- Adapter test harness: `testBackendAdapter()` helper

---

## 9. Migration Path

**Assessment: Breaking changes with no gradual path**

**Recommendation: 3-phase migration**
1. v0.2: Add adapter support, keep old API as default (opt-in)
2. v0.3: Deprecation warnings if adapter not provided
3. v1.0: Require explicit adapter selection

---

## 10. Configuration: Adapter selection UX

**Assessment: Biggest UX gap in the RFC**

User installs bridge. How do they use it with Goose? With OpenCode?

**Recommendation:**
1. Explicit: `new SessionManager({ adapter: new ACPAdapter({...}) })`
2. Config factory: `SessionManager.create({ backend: { type: 'acp', command: 'goose' } })`
3. Zero-config: `SessionManager.autoDetect({ preferredAgents: ['goose', 'claude'] })`

---

## 11. Type Safety

**Assessment: Mixed**

UnifiedMessage union unwieldy (15+ variants). No helper types for common patterns.

**Recommendation:**
1. Group message types: `ConversationMessage`, `SystemMessage`, `ToolMessage`, etc.
2. Helper utilities: `filterMessages()`, `MessagesOfType<T>`
3. Branded types for backend-specific options

---

## 12. Prioritized Recommendations

### High Priority (Block v1.0):
1. Split BackendSession into cohesive interfaces
2. Document consumer connection flow
3. Provide migration guide
4. Solve adapter selection UX

### Medium Priority (v1.1):
5. Ship consumer SDKs (vanilla TS + React hooks)
6. Adapter documentation site
7. Structured error taxonomy
8. Hybrid packaging

### Low Priority (v1.2+):
9. Builder pattern for SessionOptions
10. Type helper utilities
11. Adapter test harness
12. Auto-detection

**Estimated DX investment:** 2-3 weeks on top of core implementation.

**Verdict:** Approve architecture, block release until DX issues addressed.
