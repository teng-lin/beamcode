# ACP Research Notes — Phase 3 Adapter Planning

> Research date: 2026-02-15
> Protocol version researched: ACP v1 (PROTOCOL_VERSION = 1)

## Protocol Overview

### What is ACP?

The **Agent Client Protocol** (ACP) is an open standard that standardizes communication between code editors (clients) and AI coding agents. It was created by [Block](https://block.github.io/goose/) (originally for Goose, their open-source AI coding agent) and is now hosted under the [Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) at the Linux Foundation, alongside MCP and AGENTS.md.

ACP is analogous to LSP (Language Server Protocol) but for coding agents instead of language servers. Where LSP standardized editor↔language-server communication, ACP standardizes editor↔coding-agent communication.

**Key adopters:**
- **Editors:** Zed, JetBrains IDEs, Neovim, Marimo
- **Agents:** Claude Code, Codex CLI, Gemini CLI, Goose, StackPack

**Official resources:**
- Spec: https://agentclientprotocol.com
- GitHub: https://github.com/agentclientprotocol/agent-client-protocol
- SDKs: TypeScript, Python, Rust, Kotlin

### Transport

ACP uses **JSON-RPC 2.0 over stdio** as the primary transport:
- Client launches the agent as a subprocess
- Agent reads JSON-RPC messages from **stdin**, writes to **stdout**
- Messages are newline-delimited (`\n`), must NOT contain embedded newlines
- UTF-8 encoding required
- Agents may write logs to **stderr**
- HTTP Streamable transport is a draft proposal (not finalized)

### Message Format

All messages conform to JSON-RPC 2.0:

```jsonc
// Request (has id)
{"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {...}}

// Response (echoes id)
{"jsonrpc": "2.0", "id": 1, "result": {...}}

// Notification (no id — fire-and-forget)
{"jsonrpc": "2.0", "method": "session/update", "params": {...}}

// Error response
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32001, "message": "..."}}
```

### Protocol Lifecycle

```
Client                              Agent
  │                                   │
  ├── initialize ────────────────────►│  (capability negotiation)
  │◄──────────────── result ──────────┤
  │                                   │
  ├── session/new ───────────────────►│  (create session)
  │◄──────────────── result ──────────┤
  │                                   │
  ├── session/prompt ────────────────►│  (send user message)
  │◄── session/update (streaming) ────┤  (agent_message_chunk, tool_call, etc.)
  │◄── session/update (tool_call) ────┤
  │◄── session/request_permission ────┤  (agent requests permission)
  ├── permission response ───────────►│
  │◄── session/update (tool_result) ──┤
  │◄──────────────── result ──────────┤  (stopReason: "end_turn")
  │                                   │
  ├── session/cancel ────────────────►│  (optional: cancel in-flight)
```

---

## Core Protocol Methods

### Client → Agent Methods

| Method | Type | Purpose |
|---|---|---|
| `initialize` | Request | Negotiate protocol version and capabilities |
| `session/new` | Request | Create a new conversation session |
| `session/load` | Request | Resume a prior session (if `loadSession` capability) |
| `session/prompt` | Request | Send user message; stays open until turn completes |
| `session/cancel` | Notification | Cancel ongoing prompt processing |
| `session/set_mode` | Request | Change agent operational mode (ask/code/architect) |
| `session/set_model` | Request | Change LLM model mid-session |

### Agent → Client Methods

| Method | Type | Purpose |
|---|---|---|
| `session/update` | Notification | Stream progress, chunks, tool calls, plan updates |
| `session/request_permission` | Request | Request user approval for a tool action |
| `fs/read_text_file` | Request | Read a file from the client filesystem |
| `fs/write_text_file` | Request | Write a file to the client filesystem |
| `terminal/create` | Request | Create terminal and run a command |
| `terminal/output` | Request | Get terminal output |
| `terminal/wait_for_exit` | Request | Wait for command completion |
| `terminal/kill` | Request | Kill a running command |
| `terminal/release` | Request | Release terminal resources |

### session/update Notification Types

| `sessionUpdate` value | Purpose |
|---|---|
| `agent_message_chunk` | Streaming text response from LLM |
| `agent_thought_chunk` | Streaming reasoning/thinking |
| `tool_call` | Announce a new tool invocation |
| `tool_call_update` | Update tool status/result (in_progress, completed, failed) |
| `plan` | Multi-step plan with entries and statuses |
| `available_commands_update` | Advertise slash commands |
| `current_mode_update` | Agent-initiated mode change |

### Content Block Types

```jsonc
// Text (always supported)
{"type": "text", "text": "Hello world"}

// Image (requires image capability)
{"type": "image", "mimeType": "image/png", "data": "<base64>"}

// Audio (requires audio capability)
{"type": "audio", "mimeType": "audio/wav", "data": "<base64>"}

// Embedded resource (file with inline content)
{"type": "resource", "resource": {"uri": "file:///...", "mimeType": "text/x-python", "text": "..."}}

// Resource link (reference only)
{"type": "resource_link", "uri": "file:///doc.pdf", "name": "doc.pdf"}
```

### Tool Call Content Types

```jsonc
// Regular content
{"type": "content", "content": {"type": "text", "text": "..."}}

// Diff (file modification)
{"type": "diff", "path": "/path/to/file", "oldText": "...", "newText": "..."}

// Terminal output reference
{"type": "terminal", "terminalId": "term_xyz789"}
```

### Permission Request/Response

```jsonc
// Agent requests permission
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc",
    "toolCall": {"toolCallId": "call_001"},
    "options": [
      {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
      {"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
      {"optionId": "reject-once", "name": "Deny", "kind": "reject_once"}
    ]
  }
}

// Client responds
{"result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}}
```

### Slash Commands

Commands are advertised via `available_commands_update` and invoked as text in `session/prompt`:

```jsonc
// Agent advertises
{"sessionUpdate": "available_commands_update", "availableCommands": [
  {"name": "web", "description": "Search the web", "input": {"hint": "query"}}
]}

// Client invokes (as normal prompt text)
{"method": "session/prompt", "params": {"prompt": [{"type": "text", "text": "/web ACP protocol"}]}}
```

### Stop Reasons

| Reason | Meaning |
|---|---|
| `end_turn` | LLM finished responding |
| `max_tokens` | Token limit reached |
| `max_turn_requests` | Max model requests in a turn exceeded |
| `refusal` | Agent refuses to continue |
| `cancelled` | Client cancelled the turn |

---

## Message Mapping (ACP → UnifiedMessage)

### Outbound: Agent → Client (ACP → UnifiedMessage)

| ACP Event | UnifiedMessageType | UnifiedRole | Notes |
|---|---|---|---|
| `initialize` response | `session_init` | `system` | Map `agentCapabilities`, `agentInfo` to metadata |
| `session/new` response | `session_init` | `system` | Map `sessionId` to metadata |
| `session/update` → `agent_message_chunk` | `stream_event` | `assistant` | Content block goes in `content[]` |
| `session/update` → `agent_thought_chunk` | `stream_event` | `assistant` | Add `thought: true` in metadata |
| `session/update` → `tool_call` | `tool_progress` | `tool` | Map `toolCallId`, `title`, `kind`, `status` to metadata |
| `session/update` → `tool_call_update` (in_progress) | `tool_progress` | `tool` | Map content + status to metadata |
| `session/update` → `tool_call_update` (completed) | `tool_use_summary` | `tool` | Map final result content |
| `session/update` → `tool_call_update` (failed) | `tool_use_summary` | `tool` | `is_error: true` in metadata |
| `session/update` → `plan` | `status_change` | `system` | Map plan entries to metadata |
| `session/update` → `available_commands_update` | `unknown` | `system` | Forward-compat passthrough |
| `session/update` → `current_mode_update` | `configuration_change` | `system` | Map `modeId` to metadata |
| `session/request_permission` | `permission_request` | `system` | Map `toolCall`, `options` to metadata |
| `session/prompt` response (stopReason) | `result` | `system` | Map `stopReason` to metadata |

### Inbound: Client → Agent (UnifiedMessage → ACP)

| UnifiedMessageType | ACP Method | Notes |
|---|---|---|
| `user_message` | `session/prompt` | Extract text from `content[]`, wrap as ACP prompt blocks |
| `permission_response` | Response to `session/request_permission` | Map `behavior` → `outcome` (allow→selected, deny→selected with reject) |
| `interrupt` | `session/cancel` | Notification (no response expected) |
| `configuration_change` (model) | `session/set_model` | Extract model from metadata |
| `configuration_change` (mode) | `session/set_mode` | Extract modeId from metadata |

---

## Capability Comparison

| Feature | Claude (NDJSON) | ACP (JSON-RPC 2.0) | Gap? |
|---|---|---|---|
| **Transport** | WebSocket (NDJSON) | stdio (newline-delimited JSON-RPC) | Different transports; ACP uses subprocess stdio |
| **Streaming** | Yes (NDJSON stream) | Yes (`session/update` notifications) | **No gap** — ACP streams via notifications |
| **Permissions** | Yes (control_request/response) | Yes (`session/request_permission`) | **No gap** — ACP has richer permission model (option kinds) |
| **Slash commands** | Yes (slash_command inbound type) | Yes (`available_commands_update` + text prompt) | **No gap** — ACP advertises commands dynamically |
| **Session resume** | Yes (resume flag) | Yes (`session/load` if `loadSession` capability) | **No gap** — ACP replay via session/update |
| **Tool progress** | Yes (tool_progress type) | Yes (`tool_call` + `tool_call_update`) | **No gap** — ACP has richer tool lifecycle |
| **Interruption** | Yes (SIGINT / interrupt) | Yes (`session/cancel` notification) | **No gap** |
| **Model change** | Yes (set_model inbound) | Yes (`session/set_model` request) | **No gap** |
| **Agent modes** | No native support | Yes (`session/set_mode`, mode updates) | ACP has **more** — BeamCode could surface modes via metadata |
| **Agent plans** | No native support | Yes (`plan` session update) | ACP has **more** — plan entries map naturally to status_change |
| **Diff content** | No structured diff | Yes (`diff` content type with oldText/newText) | ACP has **more** — could map to CodeContent or metadata |
| **Terminal management** | No (PTY is external) | Yes (`terminal/*` methods) | ACP has **more** — agent delegates terminal to client |
| **File system access** | No (agent handles internally) | Yes (`fs/*` methods) | ACP has **more** — agent delegates FS to client |
| **Authentication** | External (auth_status message) | Built-in (`authMethods` in initialize) | **Minor gap** — ACP auth is richer |
| **Keep-alive** | Yes (keep_alive type) | No | Claude has more — ACP relies on process lifecycle |
| **Bidirectional RPC** | No (unidirectional NDJSON) | Yes (both sides initiate requests) | **Architectural difference** — ACP agent can call client |

### Key Architectural Difference

ACP is fundamentally **bidirectional RPC**: the agent can initiate requests to the client (e.g., `fs/read_text_file`, `terminal/create`). This is a significant departure from Claude's unidirectional model where the agent handles tools internally.

For BeamCode, this means the ACP adapter must act as **both** a JSON-RPC client (sending prompts to the agent) **and** a JSON-RPC server (responding to agent-initiated requests for file access, terminal, and permissions).

---

## BackendAdapter Interface Changes

### Current Interface Sufficiency

The current `BackendAdapter` / `BackendSession` interface is **sufficient** for ACP with no breaking changes needed. Here's why:

1. **`connect()`** → Maps to ACP's `initialize` + `session/new` sequence
2. **`send()`** → Translates `UnifiedMessage` to appropriate ACP method (`session/prompt`, `session/set_mode`, etc.)
3. **`messages` (AsyncIterable)** → Yields `UnifiedMessage` for each `session/update` notification and agent-to-client request
4. **`close()`** → Tears down the subprocess

### Capabilities Declaration

```typescript
const acpCapabilities: BackendCapabilities = {
  streaming: true,      // session/update notifications provide streaming
  permissions: true,     // session/request_permission is native
  slashCommands: true,   // available_commands_update + text invocation
  availability: "local", // stdio subprocess — local only (HTTP draft would enable "both")
};
```

**Note:** The initial comment in `backend-adapter.ts` says `"ACP: false"` for streaming — this is **incorrect**. ACP does stream via `session/update` notifications. The adapter should declare `streaming: true`.

### Bidirectional RPC Handling

The biggest implementation consideration is handling agent-initiated requests (`fs/*`, `terminal/*`). Two approaches:

**Option A (Recommended): Handle inside the adapter session**
- The ACP adapter session implements a JSON-RPC server for agent requests
- File operations are delegated to the client's workspace
- Terminal operations are delegated to the client's PTY manager
- Permission requests are forwarded as `UnifiedMessage` via the `messages` iterable

**Option B: New extension interface**
- Add an `AgentRequestHandler` extension interface for bidirectional protocols
- Consumers register handlers for file/terminal operations
- More flexible but adds interface complexity

Recommendation: **Option A** for Phase 3. The adapter can accept handler functions via `adapterOptions` in `ConnectOptions`:

```typescript
const session = await acpAdapter.connect({
  sessionId: "s-1",
  adapterOptions: {
    cwd: "/path/to/workspace",
    fileSystemHandler: myFsHandler,    // implements fs/read_text_file, fs/write_text_file
    terminalHandler: myTermHandler,    // implements terminal/* methods
  },
});
```

---

## PTY Sidecar Needs

### What ACP Handles Natively

ACP has first-class terminal support. The agent delegates command execution to the client via `terminal/*` methods. This means:

- **No PTY sidecar needed for basic command execution** — the agent asks the client to run commands
- **File I/O is client-mediated** — the agent asks the client to read/write files
- **Permissions are protocol-native** — `session/request_permission` handles approval flows

### What ACP Cannot Do (PTY Fallback Still Needed)

| Feature | Why PTY Fallback | Notes |
|---|---|---|
| **Interactive CLI features** | ACP is structured RPC — no raw terminal | Agent TUI output, interactive prompts |
| **Raw stdout capture** | ACP messages are JSON-RPC only | Cannot capture non-JSON agent output |
| **Agent stderr logging** | ACP spec says "clients can handle stderr" | Need PTY to capture + display agent logs |
| **Process signal handling** | `session/cancel` is graceful only | May need SIGINT/SIGKILL for hung agents |
| **Non-ACP agents** | Legacy agents without ACP support | PTY remains the universal fallback |
| **Agent startup/health** | ACP has no health check mechanism | PTY can monitor process liveness |

### Recommendation

For Phase 3, the ACP adapter should:
1. Use **stdio pipes** (not PTY) for the primary JSON-RPC channel
2. Capture **stderr** separately for agent logging
3. Maintain a **process handle** for signal delivery (SIGINT, SIGTERM) as fallback
4. PTY sidecar is only needed for agents that don't fully implement ACP

---

## Implementation Estimate

### Confidence Level: **HIGH**

ACP maps cleanly to the `BackendAdapter` interface. The protocol is well-specified, has official TypeScript/Python SDKs, and the message mapping is straightforward.

### Estimated LOC

| Component | Est. LOC | Notes |
|---|---|---|
| `AcpAdapter` class | ~60 | Spawn subprocess, initialize, create session |
| `AcpSession` class | ~180 | JSON-RPC client + server, message routing, close |
| `outbound-translator.ts` | ~150 | ACP session/update → UnifiedMessage (11 update types) |
| `outbound-translator.test.ts` | ~200 | One test per update type + edge cases |
| `inbound-translator.ts` | ~100 | UnifiedMessage → ACP methods (5 inbound types) |
| `inbound-translator.test.ts` | ~120 | One test per inbound type |
| `json-rpc.ts` (utility) | ~80 | JSON-RPC 2.0 message framing, ID management |
| `json-rpc.test.ts` | ~60 | Framing tests |
| **Total** | **~950** | |

### Key Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ACP spec is still evolving (v1, HTTP draft) | Medium | Pin to PROTOCOL_VERSION 1; capability negotiation handles changes |
| Bidirectional RPC adds complexity | Medium | Start with fs/terminal stubs; implement fully when consumers need them |
| Not all agents implement full ACP | Low | Capability negotiation + graceful degradation |
| Agent subprocess management | Low | Reuse existing `node-process-manager.ts` pattern |
| Streaming fidelity (chunk reassembly) | Low | `agent_message_chunk` maps directly to `stream_event` |

### Dependencies

- **Official TypeScript SDK** (`@anthropic-ai/acp-sdk` or similar) — evaluate whether to use it or implement raw JSON-RPC. Raw JSON-RPC is simpler and avoids SDK version churn.
- **Process manager** — reuse `node-process-manager.ts` for subprocess lifecycle.

### Phase 3 Timeline Fit

ACP adapter implementation fits comfortably within Phase 3. The hardest part is the bidirectional RPC handling (agent calling client for fs/terminal), but this can be implemented incrementally:
1. **Phase 3a:** Core adapter with prompt/response/streaming (no fs/terminal delegation)
2. **Phase 3b:** Add fs/terminal handlers for full ACP compliance

---

## References

- [ACP Official Spec](https://agentclientprotocol.com)
- [ACP GitHub Repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [Intro to ACP — Goose Blog](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/)
- [ACP in JetBrains IDEs](https://blog.jetbrains.com/ai/2025/12/bring-your-own-ai-agent-to-jetbrains-ides/)
- [ACP in Zed](https://zed.dev/acp)
- [ACP Progress Report — Zed Blog](https://zed.dev/blog/acp-progress-report)
- [Linux Foundation AAIF Announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [ACP Protocol Overview — DeepWiki](https://deepwiki.com/agentclientprotocol/python-sdk/4.1-agent-client-protocol-overview)
- [ACP Protocol Overview — ACPex Elixir](https://hexdocs.pm/acpex/protocol_overview.html)
