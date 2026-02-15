# Test Strategy Assessment: Universal Adapter Layer Architecture

## Executive Summary

The proposed universal adapter layer architecture is **highly testable** but requires significant test infrastructure investment. The existing Vitest-based test suite provides a solid foundation with good mocking patterns, but the multi-protocol, multi-adapter nature of this architecture introduces several novel testing challenges that demand new infrastructure.

**Critical Gap:** No contract testing framework exists. With 7+ adapters all producing `UnifiedMessage` types, ensuring protocol compatibility across adapters is the highest testing risk.

**Recommendation:** Prioritize contract testing infrastructure (test doubles for ACP agents, protocol recorders) before implementing Phase 3+ adapters.

---

## 1. Interface Testability

### BackendAdapter Interface
**Verdict: Highly Testable**

The SDK-compatible AsyncIterable pattern is excellent for testing:

```typescript
// Easy to mock with generators
async function* mockMessages(): AsyncIterable<UnifiedMessage> {
  yield { type: 'system_init', sessionId: 'test-123', ... };
  yield { type: 'assistant_message', content: [...], ... };
}

const mockAdapter: BackendAdapter = {
  createSession: vi.fn(async () => ({
    messages: () => mockMessages(),
    send: vi.fn(),
    ...
  }))
};
```

**Strengths:**
- Factory pattern separates construction from lifecycle
- AsyncIterable streams are composable and interceptable
- Capability negotiation (`getCapabilities()`) enables feature gating tests
- Promise-based control methods (`interrupt()`, `setModel()`) are easy to spy on

**Risks:**
- **Leaky abstractions:** Some adapters (PTY, ACP) may expose adapter-specific behavior that breaks substitutability
- **Partial implementation:** Optional methods (`rewindFiles()`) create test matrix explosion

**Test Infrastructure Needed:**
- Already exists: MockSocket, MockProcessManager patterns
- Missing: Base `MockBackendAdapter` test double that others can extend
- Missing: Capability matrix test generator (verify all capability combinations)

---

## 2. Adapter Testing Strategy

### Per-Adapter Test Approach

Each adapter needs **three test layers:**

#### Layer 1: Protocol Translation (Unit)
Mock the CLI/subprocess, verify translation to `UnifiedMessage`:

```typescript
// Example: SdkUrlAdapter
describe('SdkUrlAdapter protocol translation', () => {
  it('translates NDJSON system/init to system_init message', async () => {
    const mockCLI = createMockCLIProcess();
    const adapter = new SdkUrlAdapter();
    const session = await adapter.createSession({});

    mockCLI.stdout.emit('data', JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'cli-123', ...
    }) + '\n');

    const msg = await session.messages().next();
    expect(msg.value.type).toBe('system_init');
    expect(msg.value.sessionId).toBe('cli-123');
  });
});
```

#### Layer 2: Lifecycle Management (Integration)
Test spawn, resume, crash recovery:

```typescript
it('resumes session with --resume flag', async () => {
  const pm = new MockProcessManager();
  const adapter = new SdkUrlAdapter({ processManager: pm });

  await adapter.resumeSession('existing-session-id');

  expect(pm.spawnCalls[0].args).toContain('--resume');
  expect(pm.spawnCalls[0].args).toContain('existing-session-id');
});
```

#### Layer 3: Contract Compliance (Contract)
Verify all adapters implement the same contract (see section 3).

### Adapter-Specific Challenges

| Adapter | Challenge | Test Strategy |
|---------|-----------|---------------|
| **SdkUrlAdapter** | WebSocket bidirectional protocol | Use `ws` test server, capture handshake |
| **AgentSdkAdapter** | SDK callback -> async message bridge | Spy on `canUseTool`, verify Promise resolution |
| **OpenCodeAdapter** | SSE event stream parsing | Mock HTTP + SSE, verify reconnection |
| **ACPAdapter** | JSON-RPC 2.0 stdio + capability negotiation | Mock subprocess stdio, test `initialize` flow |
| **CodexAdapter** | 30+ JSON-RPC methods, thread management | Mock each critical method (thread/start, turn/start) |
| **GeminiCliAdapter** | Dual-mode (headless vs A2A) | Separate test suites per mode |
| **PtyAdapter** | ANSI parsing heuristics, keystroke injection | Golden file tests with real CLI recordings |

**Test Infrastructure Needed:**
- Missing: HTTP+SSE mock server for OpenCode
- Missing: Subprocess stdio test harness for JSON-RPC protocols
- Missing: ANSI golden file test runner for PTY
- Missing: ACP capability negotiation test fixture

---

## 3. Contract Testing

**This is the HIGHEST PRIORITY test infrastructure investment.**

### The Problem
With 7+ adapters all producing `UnifiedMessage`, how do we ensure:
- All adapters translate `assistant_message` the same way?
- `TokenUsage` fields are always present and valid?
- `permission_request` messages have the same shape across ACP, SDK, OpenCode?

### Solution: Contract Test Suite

Implement a **shared contract test suite** that all adapters must pass:

```typescript
// contract-tests.ts
export function runContractTests(adapter: BackendAdapter) {
  describe(`${adapter.backendType} Contract Compliance`, () => {
    it('emits system_init on session creation', async () => {
      const session = await adapter.createSession({});
      const msg = await session.messages().next();
      expect(msg.value.type).toBe('system_init');
      expect(msg.value).toHaveProperty('sessionId');
      expect(msg.value).toHaveProperty('model');
    });

    it('emits assistant_message with valid content blocks', async () => {
      const session = await adapter.createSession({});
      const stream = session.send('Hello');

      let assistantMsg: UnifiedMessage | undefined;
      for await (const msg of stream) {
        if (msg.type === 'assistant_message') {
          assistantMsg = msg;
          break;
        }
      }

      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content).toBeInstanceOf(Array);
      expect(assistantMsg.usage).toHaveProperty('inputTokens');
    });

    it('supports interrupt()', async () => {
      const session = await adapter.createSession({});
      const stream = session.send('Long task...');

      setTimeout(() => session.interrupt(), 100);

      const messages = [];
      for await (const msg of stream) {
        messages.push(msg);
      }
      expect(messages.some(m => m.type === 'result')).toBe(true);
    });

    // ... 20+ more contract tests
  });
}

// In each adapter's test file:
import { runContractTests } from './contract-tests';
runContractTests(new SdkUrlAdapter());
runContractTests(new ACPAdapter());
runContractTests(new OpenCodeAdapter());
```

**Contract Violations to Catch:**
- Missing required fields (e.g., `usage` in `assistant_message`)
- Type mismatches (e.g., `stopReason` as number instead of string)
- Inconsistent error handling (e.g., some throw, others emit error messages)
- Capability mismatch (e.g., adapter claims `sessionResume: true` but `resumeSession()` throws)

**Test Infrastructure Needed:**
- Missing: Contract test suite framework
- Missing: Schema validator for `UnifiedMessage` (Zod/JSON Schema)
- Missing: Capability compliance matrix generator

---

## 4. Mock Agents

### Challenge: Testing ACP Adapter Without Real Agents

The ACPAdapter needs to communicate with ACP-compliant agents (Goose, Kiro, Gemini CLI) over JSON-RPC 2.0 stdio. **We cannot rely on real agents in CI.**

### Solution: Mock ACP Agent Server

Create a configurable mock ACP agent that responds to JSON-RPC requests:

```typescript
class MockACPAgent {
  constructor(private capabilities: ACPCapabilities) {}

  async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    switch (request.method) {
      case 'initialize':
        return { id: request.id, result: this.capabilities };
      case 'session/new':
        return { id: request.id, result: { sessionId: 'mock-session' } };
      case 'session/prompt':
        return this.generateMockResponse(request.params.prompt);
      default:
        return { id: request.id, error: { code: -32601, message: 'Method not found' } };
    }
  }
}
```

**Test Infrastructure Needed:**
- Missing: MockACPAgent with configurable capabilities
- Missing: Canned response library for common prompts
- Missing: ACP protocol validator (verify requests match spec)

---

## 5. Daemon/Relay Testing

### Daemon Testing

The daemon has **three critical failure modes:**

1. **Spawn failures:** CLI not found, permissions denied, OOM
2. **Orphaned processes:** Daemon crashes, sessions survive
3. **State corruption:** `daemon.state.json` partial writes

### Relay Testing

The relay introduces **network partitions and reconnection scenarios.** Tests needed for:
- Reconnection after network partition with exponential backoff
- Failover to secondary relay
- Tunnel CLI mocking (cloudflared/ngrok without real tunnels)

**Test Infrastructure Needed:**
- Missing: File lock test harness (simulate concurrent access)
- Missing: Network partition simulator
- Missing: Mock tunnel CLI
- Missing: State file corruption test utilities

---

## 6. Permission Flow Testing

### The Challenge

Permission flows are **multi-party** with complex state:

```
Agent -> Bridge -> Consumer 1 (approves)
                   Consumer 2 (observes)
                   Consumer 3 (denied access)
```

**Critical Scenarios:**
- Multi-consumer approval race (first approval wins)
- Observer role cannot approve permissions
- Permission request timeout handling

**Test Infrastructure Needed:**
- Already exists: MockSocket with message capture
- Missing: RBAC test matrix generator (all role x permission combinations)
- Missing: Permission request timeout simulation

---

## 7. Team Coordination Testing

### File-Based Communication Race Conditions

The agent teams feature uses **file-based JSON inboxes** with polling. Critical race conditions to test:

1. **Concurrent task claiming** - Two teammates claim same task
2. **Inbox message ordering** - Concurrent writes preserve order
3. **File watcher lag** - Rapid-fire updates without missing events

**Test Infrastructure Needed:**
- Missing: File lock simulator
- Missing: File watcher test harness (control timing, simulate lag)
- Missing: Concurrent operation test runner

---

## 8. Performance Testing

### Multi-Consumer Session Load

**Scenario:** 100 consumers connected to one session streaming messages.

**Targets:**
- 100k total messages (100 consumers x 1000 messages) in < 1s
- p95 streaming latency < 10ms

**Test Infrastructure Needed:**
- Missing: Load testing framework
- Missing: Performance regression detector
- Missing: Profiling integration (CPU, memory flamegraphs)

---

## 9. E2E Strategy

### Full Chain Testing

Test the entire flow: Mobile App -> Relay -> Daemon -> Bridge -> Adapter -> Agent

**Approach:** Hermetic test environment with all components mocked/stubbed.

**Test Infrastructure Needed:**
- Missing: Hermetic E2E test environment
- Missing: Mock relay server
- Missing: E2E test orchestration (start/stop all components)

---

## 10. Regression Strategy

### Upstream Protocol Changes

**The Risk:** When Claude Code changes its NDJSON protocol, the SdkUrlAdapter breaks.

**Solution: Protocol Recorder** - Record real CLI output for regression testing with versioned recordings.

**Test Infrastructure Needed:**
- Missing: Protocol recorder CLI tool
- Missing: Regression test suite with versioned recordings
- Missing: Snapshot testing for `UnifiedMessage` output

---

## 11. Test Infrastructure Summary

### What Exists

- **Test Runner:** Vitest with coverage (v8)
- **CI:** GitHub Actions on Node 22.x, 24.x
- **Mocking:** MockSocket, MockProcessManager, MemoryStorage, NoopLogger
- **Test Patterns:** Unit + integration tests, async/await patterns
- **Coverage Reporting:** Codecov integration

### What's Missing

#### High Priority

1. **Contract Test Suite** - Shared test suite for all adapters
2. **MockACPAgent** - Configurable mock ACP agent for stdio testing
3. **Protocol Recorder** - Record/replay real CLI output for regression tests
4. **Base MockBackendAdapter** - Reusable test double for adapter interface

#### Medium Priority

5. **HTTP+SSE Mock Server** - For OpenCodeAdapter testing
6. **Subprocess Stdio Harness** - For JSON-RPC protocol testing
7. **File Lock Simulator** - For agent teams race condition testing
8. **RBAC Test Matrix** - Generate all role x permission x operation combinations
9. **Schema Validator** - Zod/JSON Schema for `UnifiedMessage` validation

#### Low Priority (Nice to Have)

10. **Load Testing Framework** - Performance regression detection
11. **E2E Test Orchestration** - Hermetic multi-component testing
12. **ANSI Golden Files** - PTY adapter regression tests
13. **Network Partition Simulator** - Relay failover testing
14. **Mock Tunnel CLI** - Cloudflared/ngrok testing without real tunnels

---

## 12. Prioritized Recommendations

### Phase 1: Foundation (Before Adapter Implementation) - 1.5-2 weeks

1. **Contract Test Suite** (3-5 days)
2. **MockACPAgent** (2-3 days)
3. **Base MockBackendAdapter** (1-2 days)

### Phase 2: Protocol Testing (Parallel with Adapter Development) - 1.5 weeks

4. **Protocol Recorder** (3-4 days)
5. **HTTP+SSE Mock Server** (2 days)
6. **Subprocess Stdio Harness** (2 days)

### Phase 3: Daemon & Teams (Before Phase 8) - 1 week

7. **File Lock Simulator** (2 days)
8. **File Watcher Harness** (1-2 days)
9. **RBAC Test Matrix Generator** (1 day)

### Phase 4: Performance & E2E (Before Production) - 2 weeks

10. **Load Testing Framework** (3-5 days)
11. **E2E Test Orchestration** (5-7 days)

---

## Total Investment

**Critical Path (Phases 1-2):** 3-3.5 weeks
**Full Infrastructure (Phases 1-4):** 6-7 weeks

**Recommendation:** Allocate 1 engineer full-time on test infrastructure for 1 month, then part-time maintenance.

---

## Final Verdict

Architecture is **highly testable** with the right infrastructure.

**Critical blocker:** No contract testing framework. Do not proceed past Phase 2 (SdkUrlAdapter extraction) without implementing contract tests.

**Prioritize:** MockACPAgent and contract test suite before implementing Phase 3 (ACPAdapter). These two pieces unlock testing for 25+ ACP-compliant agents.

---

## Appendix: Test Coverage Goals

| Component | Unit Coverage | Integration Coverage | E2E Coverage |
|-----------|--------------|---------------------|--------------|
| BackendAdapter interface | 95%+ | N/A | N/A |
| SdkUrlAdapter | 90%+ | 85%+ | 70%+ |
| ACPAdapter | 90%+ | 80%+ | 60%+ |
| AgentSdkAdapter | 85%+ | 75%+ | 60%+ |
| SessionBridge | 95%+ (already high) | 90%+ | 70%+ |
| Daemon | 85%+ | 80%+ | 50%+ |
| Relay | 80%+ | 75%+ | 50%+ |
