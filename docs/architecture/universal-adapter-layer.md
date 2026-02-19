# Universal Adapter Layer — Architectural Vision

> Status: Investigation / RFC
> Branch: refactor/investigate
> Date: 2026-02-15

## Problem Statement

The landscape of coding agent CLIs is fragmenting. Claude Code, Codex CLI, Gemini CLI, OpenCode, Goose, Kiro, and others each have different protocols, capabilities, and remote access stories. Users want to:

1. Run coding agents on a powerful desktop/server at home
2. Monitor and control sessions from a mobile device or laptop elsewhere
3. Switch between agents without changing their workflow
4. Not be locked into one vendor's ecosystem

Today, people cobble this together with SSH + tmux + Tailscale, or use one of 30+ bespoke projects that each solve a narrow slice. There is no **universal adapter layer** that abstracts the CLI-to-frontend boundary.

## Vision

Turn `claude-code-bridge` into a **runtime-agnostic adapter library** that sits between any coding agent CLI and any frontend. The library handles:

- Protocol translation (NDJSON, JSON-RPC, REST+SSE, ACP, raw PTY)
- Session lifecycle (create, resume, fork, archive)
- Authentication and RBAC (pluggable)
- Multi-consumer presence (multiple viewers per session)
- Capability negotiation (what each backend supports)
- Relay-ready architecture (for remote access over the internet)
- Agent teams coordination (multi-agent workflows)

```
┌──────────────────────────────────────────────────────────────┐
│                        FRONTENDS                             │
│  Mobile App │ Web UI │ Telegram Bot │ Discord │ Terminal     │
└──────────┬───────────┬──────────────┬─────────┬─────────────┘
           │           │              │         │
           └───────────┴──────┬───────┴─────────┘
                              │
                   Consumer Protocol (JSON/WS)
                              │
              ┌───────────────┴────────────────┐
              │         SessionBridge           │
              │  (state machine, RBAC,          │
              │   presence, history, replay)    │
              └───────────────┬────────────────┘
                              │
                    BackendAdapter interface
                    (SDK-compatible pattern)
                              │
    ┌────────┬────────┬───────┼───────┬────────┬────────┐
    │        │        │       │       │        │        │
┌───┴──┐ ┌──┴──┐ ┌───┴──┐ ┌─┴──┐ ┌──┴──┐ ┌───┴──┐ ┌──┴──┐
│Claude│ │Agent│ │ Open │ │ACP │ │Codex│ │Gemini│ │ PTY │
│Adapt.│ │ SDK │ │ Code │ │    │ │     │ │ CLI  │ │     │
│      │ │Adpt.│ │Adapt.│ │Adpt│ │Adpt.│ │Adapt.│ │Adpt.│
│NDJSON│ │TS/Py│ │REST+ │ │JSON│ │JSON │ │A2A/  │ │Raw  │
│ /WS  │ │     │ │ SSE  │ │RPC │ │RPC  │ │Head. │ │     │
└──────┘ └─────┘ └──────┘ └────┘ └─────┘ └──────┘ └─────┘
   │        │       │        │       │        │       │
Claude   Claude  OpenCode  Any    Codex   Gemini  Any CLI
Code     Code    (serve)   ACP    CLI     CLI    (fallback)
--sdk-url  SDK             Agent
```

---

## Competitive Landscape (Summary)

### Projects in This Space (~30+)

| Category | Top Projects | Stars |
|----------|-------------|-------|
| Full Web/Mobile Clients | Happy Coder, CloudCLI, The Companion, Claudable | 12K, 6K, 1.8K, 3.7K |
| WebSocket Bridges | claude-agent-server, claude-on-the-go, claude-remote | 514, 26, 10 |
| Messaging Bridges | Claude-Code-Remote (Email/Telegram), claudecode-telegram | 1K, 430 |
| Session Managers | ccmanager, claude-octopus, async-code | 851, 615, 506 |
| Kanban/Task UIs | Claude-WS | 190 |
| General Terminal | ttyd, GoTTY, tmate | 11K, 19K, 6K |
| Official | Claude Code on Web, Agent SDK, Cowork | N/A |
| Commercial | CodeRemote ($49/mo) | N/A |

### Key Observation

Every project implements its own protocol translation. No reusable library exists. `claude-code-bridge` is uniquely positioned as the **only embeddable npm library** in this space.

### Closest Architectural Competitor

**The Companion** (1.8K stars, 1 week old) uses the same `--sdk-url` mechanism. But it's a coupled Bun+Hono app, not an embeddable library.

---

## Full Agent Comparison Matrix

### Integration Methods by Agent

| Agent | Server Mode | Protocol | SDK/Client Lib | ACP Support | Headless Mode | Session Resume | Remote Access |
|-------|-------------|----------|---------------|-------------|---------------|----------------|---------------|
| **Claude Code** | `--sdk-url` (unofficial) | NDJSON/WS | Agent SDK (TS/Py) | Via adapter ([claude-code-acp](https://github.com/zed-industries/claude-code-acp)) | `claude -p` | Yes (--resume) | Teleport (web), Cowork |
| **OpenCode** | `opencode serve` | REST + SSE | `@opencode-ai/sdk` | `opencode acp` | N/A (server IS headless) | Yes | Server mode = remote-ready |
| **Codex CLI** | Yes (app-server, stdio) | JSON-RPC 2.0 / NDJSON | No | Via adapter (codex-acp) | Subprocess mode | Yes (thread/resume) | No |
| **Gemini CLI** | A2A server (experimental) | JSON-RPC 2.0 / A2A | `@google/gemini-cli-sdk` (TS) | Native ACP | `gemini -p --output-format json` | No | No |
| **Goose** | ACP server | JSON-RPC 2.0 stdio | No | Native ACP | N/A | Yes | No |
| **Kiro** | ACP server | JSON-RPC 2.0 stdio | No | Native (`kiro-cli acp`) | N/A | Yes | No |
| **GitHub Copilot** | JSON-RPC server | JSON-RPC 2.0 | `@github/copilot-sdk` | ACP support | CLI mode | No | No |
| **Cline** | Yes (gRPC server) | gRPC/Protobuf, JSONL | ACP support | ACP support | `--json --yolo` | No | Multi-frontend attach |
| **Goose** | Yes (goosed daemon) | REST+SSE, ACP/JSON-RPC | Native ACP | Native ACP | `goose run -t` | Yes | Tunnel-based |
| **Kilo Code** | Yes (`kilo serve`) | REST + SSE | No | No | N/A | Yes | `kilo attach <url>` |
| **Cursor** | Yes (cloud REST) | REST, JSON, NDJSON | No | No | `cursor-agent -p` | No | Background Agent API |
| **Copilot CLI** | Yes (JSON-RPC server) | JSON-RPC, HTTP | No | ACP support | CLI mode | No | Via server |
| **Warp Oz** | Yes (cloud REST) | REST (HTTPS) | No | No | CLI mode | No | Cloud-native |
| **Aider** | No | No | No | No | CLI with `--yes` | No | No |
| **Amp** | No | NDJSON, JSON | No | No | `-x` execute mode | No | No |
| **Trae** | No | No | No | No | `trae-cli run` | No | No |
| **Roo Code** | No (in development) | N/A | No | No | No | No | No |
| **Continue** | No | HTTPS (cloud) | No | No | `cn -p` | No | Cloud async |

### Capability Depth by Agent

| Feature | Claude Code | OpenCode | Codex CLI | Gemini CLI | Goose | Kiro |
|---------|------------|----------|-----------|------------|-------|------|
| Model switching | Yes | Yes | Yes (model/list) | Yes | Yes | Yes |
| Permission modes | Yes (5 modes) | Yes | Yes (3 modes) | No | No | No |
| Streaming | Yes | Yes (SSE) | Yes | Yes (stream-json) | Yes | Yes |
| Interrupt | Yes | Yes (abort) | Yes | Yes | Yes | Yes |
| Slash commands | Yes | Yes | No | Yes | Yes | Yes |
| MCP support | Yes | Yes | Yes | Yes | Yes | Yes |
| Structured output | Yes (JSON schema) | Yes | No | Yes (--json-schema) | No | No |
| Session fork | No | Yes | Yes (thread/fork) | No | No | No |
| File checkpointing | Yes (rewindFiles) | No | No | No | No | No |
| Agent teams | Yes (experimental) | No | No | No | No | No |
| Image input | Yes | No | No | Yes | No | Yes (via ACP) |
| Tool progress | Yes | Yes | Yes | Yes | Yes | Yes |
| Cost tracking | Yes | Yes | Yes | Yes | No | No |

### Protocol Details

**Claude Code --sdk-url**:
- Bidirectional NDJSON over WebSocket
- CLI connects TO a WebSocket server (reverse of typical)
- Messages: system/init, assistant, result, control_request, stream_event, tool_progress, tool_use_summary, auth_status
- Permission flow: control_request → permission_response

**Claude Agent SDK** (v0.2.42):
- In-process TypeScript/Python library
- V1: `query()` → `AsyncGenerator<SDKMessage>` with 16 message types
- V2 (preview): `createSession()` → `SDKSession` with `send()`/`stream()`/`close()`
- Permission flow: `canUseTool(toolName, input)` callback
- 15 hook events, MCP configs, Transport interface

**OpenCode `opencode serve`**:
- REST API + SSE event stream
- OpenAPI 3.1.1 spec, 40+ endpoints
- HTTP Basic Auth, CORS, mDNS discovery
- Key endpoints: POST /session/:id/message, GET /event (SSE), POST /session/:id/abort

**Codex CLI** (app-server mode):
- JSON-RPC 2.0 over stdin/stdout (NDJSON streaming)
- 30+ methods — the richest stdio-based agent API
- Thread management: thread/start, thread/resume, thread/fork, thread/read, thread/list, thread/archive, thread/compact/start, thread/rollback
- Turn management: turn/start, turn/steer, turn/interrupt
- Item types: userMessage, agentMessage, commandExecution, fileChange, mcpToolCall, webSearch, reasoning, plan
- Account/auth: account/read, account/login/start, account/logout, account/rateLimits/read
- Config, skills, models, MCP server management
- Schema generation: `codex app-server generate-ts` / `generate-json-schema`

**Gemini CLI**:
- Headless mode: `gemini -p --output-format json|stream-json`
- Stream-json produces NDJSON event stream
- A2A (Agent-to-Agent) server mode for inter-agent communication
- `@google/gemini-cli-sdk` TypeScript SDK

**ACP (Agent Client Protocol)** — used by Goose, Kiro, OpenCode, Claude Code (via adapter), Codex (via adapter):
- JSON-RPC 2.0 over stdio (primary), HTTP/WS transport in draft
- `initialize` → capability negotiation
- `session/new`, `session/prompt`, `session/update`, `session/cancel`
- `session/request_permission` with allow_once/always/reject_once/reject_always
- Reuses MCP data types

**Cline** (gRPC server):
- Cline Core runs as node process exposing gRPC (Protocol Buffers)
- Services: StateService, TaskService, ModelsService, FileService, UiService, McpService
- Multiple frontends can attach to a running task simultaneously
- JSONL output mode for headless/CI use

**Cursor** (Background Agent API):
- Cloud REST API at `https://api.cursor.com/v0/agents`
- Create, list, get agent runs; get conversation history
- CLI headless mode: `cursor-agent -p --output-format stream-json`
- Requires paid plan for Background Agent API

### Key Survey Takeaways

1. **Richest stdio API**: Codex app-server (30+ JSON-RPC methods) — threads, turns, items, approvals, skills, models, MCP
2. **Best HTTP server**: OpenCode `opencode serve` — only agent with full REST API + OpenAPI 3.1 spec. Kilo Code inherits this.
3. **Only teleport**: Claude Code — web-to-terminal (`--teleport`) and terminal-to-web (`--remote`)
4. **Best SDK ecosystem**: Copilot CLI (4 SDKs: Python, TS, Go, .NET), Claude Code (2: Python, TS), Warp Oz (2: Python, TS)
5. **Dominant protocol**: NDJSON/JSON streaming (Claude, Codex, Gemini, Cursor, Amp, Cline). JSON-RPC 2.0 emerging as standard (Codex, Copilot, Goose ACP)
6. **ACP adoption accelerating**: Goose, Kiro, OpenCode, Cline natively; Claude Code and Codex via adapters
7. **No server mode**: Aider (explicitly rejected), Gemini CLI (feature requested), Roo Code (in development)
8. **Remote access**: Only Claude Code (teleport), Goose (tunnel), and server-based agents (OpenCode, Kilo, Cline gRPC) enable remote control

---

## Protocol Landscape

### Three-Layer Architecture

The agent protocol ecosystem is stratifying into three complementary layers:

```
┌─────────────────────────────────────────────┐
│  Layer 3: Agent-Agent (A2A)                 │
│  Multi-agent orchestration & collaboration  │
│  Google/Linux Foundation, 100+ partners     │
├─────────────────────────────────────────────┤
│  Layer 2: Editor-Agent (ACP)                │
│  IDE/editor ↔ coding agent communication    │
│  Zed/Google, 25+ agents, 8+ editors         │
├─────────────────────────────────────────────┤
│  Layer 1: Agent-Tool (MCP)                  │
│  Agent ↔ tools/data sources                 │
│  Anthropic, near-universal adoption         │
└─────────────────────────────────────────────┘
```

### Agent Client Protocol (ACP)

- **Created by**: Zed Industries + Google (Aug 2025), Apache 2.0
- **Spec**: [agentclientprotocol.com](https://agentclientprotocol.com/), [GitHub](https://github.com/agentclientprotocol/agent-client-protocol) (2K+ stars)
- **Transport**: JSON-RPC 2.0 over stdio (primary); HTTP/WS in draft
- **SDKs**: TypeScript, Python, Rust, Kotlin, Go (community by Coder)
- **Editors**: Zed, JetBrains, Neovim, Emacs, Obsidian, marimo
- **Agents**: Claude Code (via adapter), Gemini CLI, Codex (via adapter), Copilot, Goose, Kiro, Cline, OpenHands, 25+ total

**Key ACP methods**:

| Direction | Method | Purpose |
|-----------|--------|---------|
| Client→Agent | `initialize` | Capability negotiation |
| Client→Agent | `session/new` | Create session |
| Client→Agent | `session/prompt` | Send user message |
| Client→Agent | `session/cancel` | Interrupt |
| Client→Agent | `session/set_mode` | Change operating mode |
| Agent→Client | `session/update` | Stream progress (chunks, tool calls, plans) |
| Agent→Client | `session/request_permission` | Ask user authorization |
| Agent→Client | `fs/read_text_file` | Read file from client |
| Agent→Client | `terminal/create` | Spawn terminal |

**ACP capability negotiation**: During `initialize`, both sides declare what they support — filesystem access, terminal, session loading, image content, MCP transports.

### Agent-to-Agent Protocol (A2A)

- **Created by**: Google (Apr 2025), now under Linux Foundation
- **Transport**: HTTPS with JSON-RPC 2.0
- **Key concepts**: Agent Cards (capability discovery), Task lifecycle, context sharing
- **Adoption**: 100+ partners (Atlassian, Box, Salesforce, SAP, etc.)
- **Used by**: Gemini CLI's A2A server mode

### Model Context Protocol (MCP)

- **Created by**: Anthropic
- **Purpose**: Agent ↔ tools/data sources
- **Relationship**: Complementary to ACP. "MCP handles the *what* (tools/data), ACP handles the *where* (workflow integration)"
- **SDKs**: TypeScript, Python, Go, Rust, Kotlin, C#

### Bridge's Position in the Protocol Landscape

| Aspect | ACP | claude-code-bridge | Opportunity |
|--------|-----|-------------------|-------------|
| Transport | stdio (subprocess) | WebSocket (network) | Bridge provides network transport ACP lacks |
| Consumers | Single client (editor) | Multiple consumers with RBAC | Bridge adds multi-consumer layer |
| Persistence | Agent-side (optional) | Bridge-level (message history, replay) | Bridge adds persistence |
| Multi-tenancy | None | Roles (participant/observer) | Bridge adds collaboration |
| Remote access | None (local only) | Relay architecture | Bridge enables remote |
| Session mgmt | Basic (new/load) | Full (create, resume, fork, archive) | Bridge adds lifecycle |

**Strategy**: The bridge should be both an **ACP client** (consuming ACP agents) and an **ACP server** (exposing sessions to ACP editors). This positions it as a multiplexer/relay in the ACP ecosystem.

---

## Agent Teams

### Overview

Claude Code's experimental **agent teams** feature (Feb 2026) enables multi-agent workflows coordinated through a file-based protocol. This is relevant because:

1. The bridge should surface team coordination to remote consumers
2. Multiple agents in a team may each need their own BackendSession
3. Team-level observability needs a unified view

### Architecture

```
Team Lead (Claude Code session)
  ├── TeamCreate → ~/.claude/teams/{name}/config.json
  ├── TaskCreate → ~/.claude/tasks/{name}/
  ├── Task tool → spawns teammates (subprocess agents)
  ├── SendMessage → inter-agent messages (DMs, broadcasts)
  └── Teammates work on TaskList, mark TaskUpdate
```

### Core Primitives

| Primitive | Purpose |
|-----------|---------|
| `TeamCreate` | Create team + task list |
| `TaskCreate` | Add task to shared list |
| `TaskUpdate` | Claim, progress, complete tasks |
| `TaskList` | View all tasks and status |
| `SendMessage` | DMs, broadcasts, shutdown requests |
| `Task` (spawn) | Create teammate subprocess |
| `TeamDelete` | Clean up team resources |

### File-Based Coordination

- **Team config**: `~/.claude/teams/{name}/config.json` — members array with name, agentId, agentType
- **Task list**: `~/.claude/tasks/{name}/` — shared task tracking
- **Teammate modes**: `in-process`, `tmux` (separate terminal pane), `auto`
- **Hooks**: `TeammateIdle`, `TaskCompleted` events for observability

### Observability Challenges

**The biggest gap: no unified event stream.** Each teammate is a separate Claude Code process. There is no single stream carrying all team activity. The bridge must aggregate from multiple sources:

1. **Lead session's SDK stream** — tool calls (TeamCreate, TaskCreate, SendMessage) appear as regular `tool_use` content blocks
2. **File system events** — watch `~/.claude/teams/` and `~/.claude/tasks/` for real-time state changes
3. **Hook events** — `TeammateIdle`, `TaskCompleted`, `SubagentStart`, `SubagentStop` can POST to a central HTTP server
4. **Inbox files** — `~/.claude/teams/{name}/inboxes/{agent}.json` contain inter-agent messages

**Teammate sessions are NOT observable via the lead's SDK stream.** They are fully independent processes with separate context windows (~200K tokens each, ~800K total for 3-person team).

### Key Limitations

- No session resumption for teammates (`/resume` doesn't restore in-process teammates)
- No nested teams (teammates can't spawn their own teams)
- Fixed lead for team lifetime (no leadership transfer)
- No programmatic SDK API for teams — it's a TUI feature using internal tools
- Costs scale linearly: each teammate maintains a full context window

### Bridge Integration Strategy

The bridge can provide a **unified dashboard** that aggregates all team activity into a single WebSocket stream:

**Data sources:**
- File watcher on `~/.claude/teams/` and `~/.claude/tasks/` directories
- Hook scripts that POST `TeammateIdle`/`TaskCompleted` events to the bridge's HTTP endpoint
- Lead session's BackendSession for the lead's perspective
- Inbox file parsing for inter-agent message history

**Consumer-facing features:**
- Team topology view (members, roles, status)
- Task board with dependency graph
- Inter-agent message threading
- Per-agent activity streaming
- Aggregate cost and token tracking
- Permission approval across the team
- Team shutdown coordination from mobile

**Related projects:**
- [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) — reimplements team protocol as standalone MCP server
- [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — hook-based observability with Vue dashboard

---

## Process Architecture: Subagents & Agent Teams

### How the CLI Spawns Subagents

When Claude decides to delegate via the Task tool, the behavior varies by display mode:

| Mode | Process Model | Lifecycle | Notes |
|------|--------------|-----------|-------|
| **In-process** (default) | Same Node.js process | Dies with leader | Fastest, invisible to OS |
| **tmux** | Separate `claude` subprocess per pane | Survives leader exit | Visible in `tmux ls` |
| **iTerm2** | Separate `claude` subprocess per split | macOS only | Visible in iTerm2 panes |

**In the default in-process mode, subagents are NOT separate OS processes.** Each subagent is an isolated context window within the same Node.js runtime. This is a critical implementation detail — it means:

- Up to 10 concurrent background subagents share the same event loop
- Foreground subagents block the main conversation
- All subagents share memory but have isolated context windows (~200K tokens each)
- Subagent crash can affect the parent process

**Backend auto-detection** checks `$TMUX`, `$TERM_PROGRAM`, `which tmux`, and `which it2` to determine which mode to use.

### Task Tool Invocation Format

```json
{
  "name": "Task",
  "input": {
    "description": "Review authentication code",
    "subagent_type": "code-reviewer",
    "prompt": "Review the auth module for security issues",
    "model": "sonnet",
    "run_in_background": true,
    "team_name": null
  }
}
```

Each subagent instance receives:
- Custom system prompt (from agent definition's markdown body or `prompt` field)
- Scoped tool list (from the `tools` field)
- Independent permission settings
- Working directory context
- Does **NOT** receive the parent's full conversation history or system prompt

### Agent SDK Spawns One Subprocess

The Agent SDK (Python and TypeScript) does not directly spawn subagent processes. It spawns exactly **one** `claude` CLI subprocess and passes agent definitions through the **initialize control protocol** over stdin:

```
SDK Application
    |
    |  [spawns one subprocess: claude --output-format stream-json --input-format stream-json ...]
    |
    v
claude CLI process (main)
    |-- stdin  <-- initialize request with agent definitions
    |-- stdout --> stream-json output (messages, tool_use, tool_result)
    |
    |  [CLI decides to use Task tool internally]
    |  [Creates in-process subagent (default) or subprocess (tmux)]
    |
    +-- Subagent (in-process or subprocess depending on mode)
```

**SDK initialize request** (from [subprocess_cli.py](https://github.com/anthropics/claude-agent-sdk-python/blob/4d747482/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L273)):
```python
request = {
    "subtype": "initialize",
    "hooks": hooks_config,
    "agents": {
        "code-reviewer": {
            "description": "Expert code review specialist.",
            "prompt": "You are a code review specialist...",
            "tools": ["Read", "Grep", "Glob"],
            "model": "sonnet"
        }
    }
}
```

Agent definitions are always sent via the initialize request (not CLI flags), to avoid ARG_MAX limits on large agent definition sets.

### Subagent Result Delivery

Results flow back via the `TaskOutputTool`:

1. Subagent completes work
2. `TaskOutputTool` packages: final text, inline display (capped at 3 lines), transcript file reference, metrics (tokens, tool uses, duration, cost)
3. Parent receives `tool_result` corresponding to the original `Task` tool_use
4. `SubagentStop` hook fires with `agent_id`, `agent_transcript_path`, `agent_type`

**Stream detection** — the SDK can identify subagent context via `parent_tool_use_id`:
```python
async for message in query(prompt="...", options=options):
    if hasattr(message, "parent_tool_use_id") and message.parent_tool_use_id:
        print("  (running inside subagent)")
```

### Agent Team Spawn Mechanism

The **Task tool with a `team_name` parameter** is what distinguishes a team teammate from a regular subagent. The spawned teammate is a full Claude Code instance with team-specific tooling:

```javascript
Task({
  "description": "QA task for frontend pages",
  "subagent_type": "general-purpose",
  "name": "qa-pages",
  "team_name": "blog-qa",
  "model": "sonnet"
})
```

**Environment variables injected into each teammate**:

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_TEAM_NAME` | Identifies the team |
| `CLAUDE_CODE_AGENT_ID` | Unique agent identifier (format: "name@team") |
| `CLAUDE_CODE_AGENT_NAME` | Teammate's assigned name |
| `CLAUDE_CODE_AGENT_TYPE` | The subagent type specified during spawning |
| `CLAUDE_CODE_AGENT_COLOR` | Hex color for UI representation |
| `CLAUDE_CODE_PLAN_MODE_REQUIRED` | Boolean for plan approval workflows |
| `CLAUDE_CODE_PARENT_SESSION_ID` | Links to leader session |

### File-Based Communication Detail

**Inter-agent messaging** is entirely file-based. No shared memory, no WebSocket, no Unix socket IPC.

```
~/.claude/teams/{team-name}/
    config.json              # Team metadata, members list
    inboxes/
        team-lead.json       # Lead's inbox
        qa-pages.json        # Teammate inbox
        qa-posts.json        # Teammate inbox

~/.claude/tasks/{team-name}/
    1.json                   # Task file
    2.json                   # Task file
```

**Inbox message format** (`inboxes/{agent-name}.json`):
```json
{
  "from": "agent-name",
  "text": "message content or JSON payload",
  "timestamp": "ISO8601",
  "read": false
}
```

**Task claiming**: File-lock-based claiming prevents race conditions when multiple teammates try to claim the same task. Status flow: `pending` → `in_progress` → `completed`.

**Inbox polling**: There is no real-time event system. Agents poll their inbox files for new messages.

### Process Architecture Diagram

```
SDK APPLICATION
    |
    | [spawns one subprocess via anyio.open_process / child_process.spawn]
    |
    v
CLAUDE CLI PROCESS (main / team lead)
    |-- CLAUDE_CODE_TEAM_NAME="my-team" (if team mode)
    |
    |== SUBAGENT SPAWN (Task tool, no team_name) ==
    |
    |   IN-PROCESS (default):
    |   +-- Subagent Instance (same Node.js process)
    |   |   |-- Own context window (isolated, ~200K tokens)
    |   |   |-- Scoped tools, own system prompt
    |   |   |-- Result via TaskOutputTool → tool_result in parent stream
    |   |   +-- Transcript: ~/.claude/projects/{proj}/{session}/subagents/agent-{id}.jsonl
    |   |
    |   TMUX:
    |   +-- [tmux pane] claude subprocess (separate OS process)
    |       |-- Full Claude Code session
    |       +-- PID tracked by parent
    |
    |== TEAM SPAWN (Task tool, with team_name) ==
    |
    |   1. TeamCreate → ~/.claude/teams/my-team/config.json
    |   2. TaskCreate → ~/.claude/tasks/my-team/{id}.json
    |   3. Task(team_name="my-team") → spawns teammates:
    |
    |   IN-PROCESS (default):
    |   +-- Teammate "frontend" (same Node.js, env: CLAUDE_CODE_AGENT_NAME=frontend)
    |   +-- Teammate "backend"  (same Node.js, env: CLAUDE_CODE_AGENT_NAME=backend)
    |
    |   TMUX:
    |   +-- [tmux pane] claude subprocess "frontend"
    |   +-- [tmux pane] claude subprocess "backend"
    |
    |   Communication: File-based JSON inboxes at ~/.claude/teams/my-team/inboxes/
    |   Task coordination: File-based JSON with file locking at ~/.claude/tasks/my-team/
    |
    |== SHUTDOWN ==
    |
    |   4. SendMessage(type=shutdown_request) → writes to teammate's inbox
    |   5. Teammate reads request → calls approveShutdown(requestId)
    |   6. TeamDelete → removes ~/.claude/teams/my-team/ and ~/.claude/tasks/my-team/

COMMUNICATION SUMMARY:
    SDK ↔ CLI:         stdio pipes (stream-json over stdin/stdout)
    Parent ↔ Subagent: In-process message bus (same Node.js) OR separate processes
    Lead ↔ Teammate:   File-based JSON inboxes (no shared memory, no sockets)
    Task coordination:  File-based JSON with file locking
    Control protocol:   Bidirectional JSON control_request/control_response over stdio
```

### Hook Events for Observability

| Hook | Fires When | Data |
|------|-----------|------|
| `SubagentStart` | Task tool about to spawn | `agent_type`, `agent_id`, `prompt` |
| `SubagentStop` | Subagent about to return result | `agent_id`, `agent_transcript_path`, `agent_type` |
| `TeammateIdle` | Teammate finishes and finds no work | `teammate_id`, `team_name` |
| `TaskCompleted` | Task being marked complete | `task_id`, `agent_type`, `duration_ms`, `token_count` |

Exit code 2 from `TeammateIdle` sends feedback and keeps the teammate working. Exit code 2 from `TaskCompleted` prevents completion.

---

## SDK-Compatible Adapter Interface

The core abstraction is designed to be **compatible with the Claude Agent SDK** interface patterns while supporting all backends. This means:

- **AsyncGenerator-based message streams** (matching SDK's `Query` interface)
- **Session-oriented API** (matching SDK's V2 `createSession`/`send`/`stream`)
- **Method parity** where applicable (`interrupt()`, `setModel()`, `setPermissionMode()`)
- **Message type alignment** (UnifiedMessage mirrors SDKMessage union)

### BackendAdapter — Factory Interface

```typescript
/**
 * BackendAdapter is a factory that creates sessions for a specific backend type.
 * Modeled after @anthropic-ai/claude-agent-sdk's unstable_v2_createSession().
 *
 * Each implementation encapsulates how to spawn/connect to a specific CLI.
 */
interface BackendAdapter {
  /** Unique identifier: "claude" | "agent-sdk" | "opencode" | "acp" | "codex" | "gemini" | "pty" */
  readonly backendType: string

  /** Declare capabilities without creating a session */
  getCapabilities(): BackendCapabilities

  /** Create a new session — analogous to SDK's createSession() */
  createSession(options: SessionOptions): Promise<BackendSession>

  /** Resume an existing session — analogous to SDK's query({ sessionId, resume: true }) */
  resumeSession(sessionId: string, options?: Partial<SessionOptions>): Promise<BackendSession>

  /** Clean up adapter-level resources (connection pools, etc.) */
  dispose(): Promise<void>
}

interface SessionOptions {
  /** Working directory */
  cwd?: string
  /** Model to use */
  model?: string
  /** Permission mode */
  permissionMode?: string
  /** Environment variables */
  env?: Record<string, string>
  /** System prompt override */
  systemPrompt?: string
  /** Allowed tools */
  allowedTools?: string[]
  /** MCP server configurations */
  mcpServers?: McpServerConfig[]
  /** Max budget in USD (print mode) */
  maxBudgetUsd?: number
  /** Max turns (print mode) */
  maxTurns?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
}
```

### BackendSession — Conversation Interface

```typescript
/**
 * BackendSession represents a single conversation with a coding agent.
 *
 * Modeled after the Claude Agent SDK's Query interface:
 *   - Implements AsyncIterable<UnifiedMessage> (like Query extends AsyncGenerator<SDKMessage>)
 *   - Control methods match SDK: interrupt(), setModel(), setPermissionMode()
 *   - initializationResult() mirrors SDK exactly
 *
 * The SessionBridge wraps this with multi-consumer support, RBAC, presence,
 * and message history — features that are bridge-level concerns, not backend concerns.
 */
interface BackendSession {
  // === Identity ===

  /** Session ID assigned by the backend */
  readonly sessionId: string

  /** Backend type this session belongs to */
  readonly backendType: string

  /** Whether the backend is currently connected and responsive */
  readonly isConnected: boolean

  // === Message Stream (matches SDK's AsyncGenerator<SDKMessage>) ===

  /**
   * Async iterable of all messages from the backend.
   * This is the primary way to consume backend events.
   *
   * SDK equivalent: iterating over Query (which extends AsyncGenerator<SDKMessage>)
   *
   * Usage:
   *   for await (const msg of session.messages()) {
   *     switch (msg.type) { ... }
   *   }
   */
  messages(): AsyncIterable<UnifiedMessage>

  // === Outbound Commands (Consumer → CLI) ===

  /**
   * Send a user message and get a stream of response messages.
   *
   * SDK equivalent:
   *   V1: query(prompt, options) → AsyncGenerator<SDKMessage>
   *   V2: session.send({ message }) then session.stream() → AsyncGenerator<SDKMessage>
   */
  send(content: string, options?: SendOptions): AsyncIterable<UnifiedMessage>

  /**
   * Respond to a permission request from the agent.
   *
   * SDK equivalent: canUseTool callback returning PermissionResult
   * ACP equivalent: response to session/request_permission
   */
  respondToPermission(requestId: string, decision: PermissionDecision): void

  /**
   * Interrupt the current operation.
   *
   * SDK equivalent: query.interrupt()
   * ACP equivalent: session/cancel notification
   */
  interrupt(): void

  // === Configuration (matches SDK Query methods) ===

  /**
   * Switch model mid-session.
   *
   * SDK equivalent: query.setModel(model)
   * ACP equivalent: session/set_config_option
   */
  setModel(model: string): void

  /**
   * Switch permission mode.
   *
   * SDK equivalent: query.setPermissionMode(mode)
   * ACP equivalent: session/set_mode
   */
  setPermissionMode(mode: string): void

  // === Introspection (matches SDK Query methods) ===

  /**
   * Get initialization result including capabilities, commands, models, account info.
   *
   * SDK equivalent: query.initializationResult()
   * Resolves once the backend has sent its init/capabilities message.
   */
  initializationResult(): Promise<InitializationResult>

  /**
   * Get available slash commands.
   *
   * SDK equivalent: query.supportedCommands()
   */
  supportedCommands(): Promise<SupportedCommand[]>

  /**
   * Get available models.
   *
   * SDK equivalent: query.supportedModels()
   */
  supportedModels(): Promise<SupportedModel[]>

  /**
   * Get MCP server status.
   *
   * SDK equivalent: query.mcpServerStatus()
   */
  mcpServerStatus(): Promise<McpServerStatus[]>

  /**
   * Get account info.
   *
   * SDK equivalent: query.accountInfo()
   */
  accountInfo(): Promise<AccountInfo | null>

  // === Extended Operations ===

  /**
   * Execute a slash command.
   *
   * Not in SDK (SDK uses streamInput for some of these).
   * ACP agents may support custom _kiro/slash_command methods.
   */
  executeCommand(command: string): Promise<CommandResult>

  /**
   * Rewind files to their state before agent modifications.
   *
   * SDK equivalent: query.rewindFiles()
   */
  rewindFiles?(): Promise<void>

  /**
   * What this backend supports — used for feature gating in frontends.
   */
  readonly capabilities: BackendCapabilities

  // === Lifecycle ===

  /**
   * Gracefully close the session.
   *
   * SDK equivalent: query.close() / session.close()
   */
  close(): Promise<void>

  /**
   * Async disposal support.
   *
   * SDK equivalent: session[Symbol.asyncDispose]()
   */
  [Symbol.asyncDispose](): Promise<void>
}

interface SendOptions {
  /** Image attachments */
  images?: ImageAttachment[]
  /** Abort signal for this specific send */
  signal?: AbortSignal
}

interface ImageAttachment {
  mediaType: string
  data: string // base64
}

interface PermissionDecision {
  behavior: 'allow' | 'deny'
  /** Modified tool input (e.g., user edited the command) */
  updatedInput?: Record<string, unknown>
  /** Permission rules to persist */
  updatedPermissions?: PermissionRuleUpdate[]
  /** Optional message to the agent */
  message?: string
}

interface PermissionRuleUpdate {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode'
  rules?: { toolName: string; ruleContent?: string }[]
  behavior?: 'allow' | 'deny' | 'ask'
  destination?: 'userSettings' | 'projectSettings' | 'localSettings' | 'session'
  mode?: string
}
```

### BackendCapabilities

```typescript
interface BackendCapabilities {
  // Core
  streaming: boolean
  interrupt: boolean
  sessionResume: boolean

  // Configuration
  modelSwitching: boolean
  permissionModes: boolean
  permissionModeSwitchingMidSession: boolean

  // Features
  slashCommands: boolean
  mcp: boolean
  structuredOutput: boolean
  imageInput: boolean
  fileCheckpointing: boolean
  costTracking: boolean
  agentTeams: boolean

  // Session management
  sessionFork: boolean
  sessionArchive: boolean

  // Protocol info
  nativeProtocol: 'ndjson-ws' | 'agent-sdk' | 'rest-sse' | 'json-rpc-stdio' | 'acp' | 'a2a' | 'pty'

  // Discovery
  supportedModels?: SupportedModel[]
  supportedPermissionModes?: string[]
  supportedCommands?: SupportedCommand[]
}

interface SupportedModel {
  id: string
  displayName: string
  description?: string
}

interface SupportedCommand {
  name: string
  description: string
  argumentHint?: string
}

interface McpServerStatus {
  name: string
  status: string
}

interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
}

interface InitializationResult {
  sessionId: string
  cwd: string
  model: string
  permissionMode: string
  tools: string[]
  mcpServers: McpServerStatus[]
  commands: SupportedCommand[]
  models: SupportedModel[]
  account: AccountInfo | null
  version?: string
  capabilities: BackendCapabilities
}

interface CommandResult {
  content: string
  source: 'native' | 'emulated' | 'pty'
}
```

### UnifiedMessage — Common Message Type

```typescript
/**
 * UnifiedMessage is the normalized message format used across all adapters.
 * Designed to align with @anthropic-ai/claude-agent-sdk SDKMessage types.
 *
 * Mapping from SDK:
 *   SDKAssistantMessage     → assistant_message
 *   SDKPartialAssistantMessage → partial_message (streaming delta)
 *   SDKResultMessage        → result
 *   SDKSystemMessage        → system
 *   SDKStatusMessage        → status
 *   SDKToolProgressMessage  → tool_progress
 *   SDKToolUseSummaryMessage→ tool_use_summary
 *   SDKAuthStatusMessage    → auth_status
 *   SDKHookStarted/Progress → hook_event (optional)
 *   SDKTaskNotificationMessage → task_notification (agent teams)
 *   SDKCompactBoundaryMessage  → compact_boundary
 *
 * Mapping from ACP:
 *   session/update (message_chunk) → partial_message
 *   session/update (tool_call)     → tool_use (extracted from assistant content)
 *   session/request_permission     → permission_request
 *   PromptResponse                 → result
 */
type UnifiedMessage =
  // === Core Conversation ===

  /** Complete assistant message with content blocks.
   *  SDK: SDKAssistantMessage */
  | {
      type: 'assistant_message'
      messageId: string
      model: string
      content: ContentBlock[]
      stopReason: string | null
      usage: TokenUsage
      parentToolUseId: string | null
    }

  /** Streaming delta for partial assistant output.
   *  SDK: SDKPartialAssistantMessage */
  | {
      type: 'partial_message'
      event: unknown
      parentToolUseId: string | null
    }

  /** Final result of a turn/query.
   *  SDK: SDKResultMessage */
  | {
      type: 'result'
      subtype: 'success' | 'error_during_execution' | 'error_max_turns'
        | 'error_max_budget_usd' | 'error_max_structured_output_retries'
      isError: boolean
      result?: string
      errors?: string[]
      cost: number
      turns: number
      durationMs: number
      durationApiMs: number
      usage: TokenUsage
      stopReason: string | null
      modelUsage?: Record<string, ModelUsage>
      linesAdded?: number
      linesRemoved?: number
    }

  // === System & Status ===

  /** Session initialization data.
   *  SDK: SDKSystemMessage (subtype: init) */
  | {
      type: 'system_init'
      sessionId: string
      cwd: string
      model: string
      permissionMode: string
      tools: string[]
      mcpServers: McpServerStatus[]
      version: string
      slashCommands: string[]
      agents?: string[]
    }

  /** Status change (compacting, etc).
   *  SDK: SDKStatusMessage */
  | {
      type: 'status'
      status: 'compacting' | null
      permissionMode?: string
    }

  /** Context compaction boundary.
   *  SDK: SDKCompactBoundaryMessage */
  | { type: 'compact_boundary' }

  // === Tool Execution ===

  /** Tool use progress notification.
   *  SDK: SDKToolProgressMessage */
  | {
      type: 'tool_progress'
      toolUseId: string
      toolName: string
      parentToolUseId: string | null
      elapsedSeconds: number
    }

  /** Summary of preceding tool uses.
   *  SDK: SDKToolUseSummaryMessage */
  | {
      type: 'tool_use_summary'
      summary: string
      precedingToolUseIds: string[]
    }

  // === Permissions ===

  /** Permission request from the agent.
   *  SDK: canUseTool callback invocation
   *  ACP: session/request_permission */
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      toolUseId: string
      input: Record<string, unknown>
      description?: string
      permissionSuggestions?: PermissionRuleUpdate[]
      agentId?: string
    }

  // === Authentication ===

  /** Auth status update.
   *  SDK: SDKAuthStatusMessage */
  | {
      type: 'auth_status'
      isAuthenticating: boolean
      output: string[]
      error?: string
    }

  // === Agent Teams ===

  /** Task notification from agent teams.
   *  SDK: SDKTaskNotificationMessage */
  | {
      type: 'task_notification'
      taskId: string
      event: 'created' | 'updated' | 'completed'
      data: unknown
    }

  // === Hooks (optional, for advanced consumers) ===

  /** Hook lifecycle event.
   *  SDK: SDKHookStartedMessage, SDKHookProgressMessage, SDKHookResponseMessage */
  | {
      type: 'hook_event'
      hookEvent: string
      hookName: string
      status: 'started' | 'progress' | 'completed'
      data?: unknown
    }

  // === Errors ===

  | {
      type: 'error'
      message: string
      recoverable: boolean
    }

  // === Keep-alive ===

  | { type: 'keep_alive' }

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

interface ModelUsage extends TokenUsage {
  contextWindow: number
  maxOutputTokens: number
  costUSD: number
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: 'thinking'; thinking: string; budget_tokens?: number }
```

### SDK Compatibility Summary

| SDK Interface | BackendSession Equivalent | Notes |
|---------------|--------------------------|-------|
| `query()` → `AsyncGenerator<SDKMessage>` | `session.messages()` → `AsyncIterable<UnifiedMessage>` | Same pattern, different type names |
| `query.interrupt()` | `session.interrupt()` | Identical |
| `query.setModel(m)` | `session.setModel(m)` | Identical |
| `query.setPermissionMode(m)` | `session.setPermissionMode(m)` | Identical |
| `query.initializationResult()` | `session.initializationResult()` | Identical |
| `query.supportedCommands()` | `session.supportedCommands()` | Identical |
| `query.supportedModels()` | `session.supportedModels()` | Identical |
| `query.mcpServerStatus()` | `session.mcpServerStatus()` | Identical |
| `query.accountInfo()` | `session.accountInfo()` | Identical |
| `query.rewindFiles()` | `session.rewindFiles()` | Optional (not all backends) |
| `query.close()` | `session.close()` | Identical |
| `canUseTool` callback | `session.respondToPermission()` | Pull vs push (bridge needs push) |
| `createSession(opts)` | `adapter.createSession(opts)` | Same shape |
| `SDKMessage` union | `UnifiedMessage` union | 1:1 mapping for most types |

The key architectural difference: **SDK uses a pull model** (the caller iterates the generator and handles `canUseTool` via callback), while **the bridge uses a push model** (messages are broadcast to multiple consumers, permissions are requested via messages and responded to asynchronously). The BackendSession bridges this gap by implementing AsyncIterable (pull) while the SessionBridge consumes it and broadcasts to consumers (push).

---

## Adapter Implementation Notes

### ClaudeAdapter (Claude Code --sdk-url)

**Current implementation**: This is what the bridge does today. Refactoring extracts the NDJSON parsing and message construction from `SessionBridge` into this adapter.

```
createSession(): spawn `claude --sdk-url ws://host:port/ws/cli/{sessionId}`  # --sdk-url is the CLI flag
resumeSession(): spawn with `--resume {id}`
send(): serialize { type: "user", message: { role: "user", content: [...] } } as NDJSON
messages(): parse NDJSON lines → translate CLIMessage → UnifiedMessage
```

**Protocol**: NDJSON over WebSocket (CLI connects TO the bridge's WS server).

**Capabilities**: streaming=yes, interrupt=yes, modelSwitching=yes, permissionModes=yes, sessionResume=yes, slashCommands=via-pty, mcp=yes, structuredOutput=no, imageInput=yes, costTracking=yes, agentTeams=yes.

### AgentSdkAdapter (Claude Code Official SDK)

**Approach**: Import `@anthropic-ai/claude-agent-sdk`, use V2 session API.

```
createSession(): unstable_v2_createSession({ model, cwd, permissionMode })
send(): session.send(content) → session.stream() → translate SDKMessage → UnifiedMessage
respondToPermission(): fulfilled via canUseTool callback's Promise resolution
interrupt(): query.interrupt() or AbortController.abort()
```

**Protocol**: In-process TypeScript library (subprocess spawned internally by SDK).

**Capabilities**: streaming=yes, interrupt=yes, modelSwitching=no (set at creation), permissionModes=no (set at creation), sessionResume=yes, slashCommands=no, mcp=yes, structuredOutput=yes, imageInput=yes, costTracking=yes, agentTeams=no, fileCheckpointing=yes.

**Note**: Permission handling requires bridging the SDK's callback model to the bridge's async message model. The adapter stores pending permission Promises and resolves them when `respondToPermission()` is called.

### OpenCodeAdapter (REST + SSE)

**Approach**: HTTP client to OpenCode's server API.

```
createSession(): POST /session → GET /event (SSE stream)
send(): POST /session/:id/message { parts: [{ type: "text", text }] }
respondToPermission(): POST /permission/:id/respond
interrupt(): POST /session/:id/abort
messages(): parse SSE events → translate to UnifiedMessage
```

**Protocol**: REST + Server-Sent Events.

**Capabilities**: streaming=yes, interrupt=yes, modelSwitching=yes, permissionModes=yes, sessionResume=yes, slashCommands=yes, mcp=yes, structuredOutput=yes, sessionFork=yes, costTracking=yes.

**OpenCode is the easiest to adapt** — proper API with typed responses and OpenAPI spec.

### ACPAdapter (Any ACP-Compliant Agent)

**Approach**: Implement ACP client using the TypeScript or Go SDK. Spawn the agent subprocess and communicate via JSON-RPC 2.0 over stdin/stdout.

```
createSession():
  spawn agent subprocess (e.g., `goose acp`, `kiro-cli acp`, `gemini acp`)
  send initialize → receive capabilities
  send session/new → receive session ID
send(): session/prompt request → consume session/update notifications
respondToPermission(): response to session/request_permission
interrupt(): session/cancel notification
messages(): translate session/update payloads → UnifiedMessage
```

**Protocol**: JSON-RPC 2.0 over stdio.

**Capabilities**: Varies by agent — discovered during `initialize` capability negotiation. The adapter queries the agent's declared capabilities and populates BackendCapabilities accordingly.

**This is the most strategic adapter** — a single implementation covers every ACP-compliant agent (Goose, Kiro, Cline, OpenHands, Gemini CLI, and any future ACP agent).

### CodexAdapter (JSON-RPC App-Server)

**Approach**: Spawn Codex CLI in app-server mode, communicate via JSON-RPC 2.0 over stdin/stdout with NDJSON streaming. Codex has the richest stdio API of any agent (30+ methods).

```
createSession(): spawn `codex app-server`, send thread/start
resumeSession(): thread/resume with threadId
send(): turn/start { prompt } → consume NDJSON events (item deltas, approvals)
respondToPermission(): respond to item/*/requestApproval with approval/rejection
interrupt(): turn/interrupt
messages(): parse NDJSON notifications → translate to UnifiedMessage
```

**Protocol**: JSON-RPC 2.0 over subprocess stdio (NDJSON streaming).

**Capabilities**: streaming=yes, interrupt=yes, modelSwitching=yes (model/list), permissionModes=yes (3 modes), sessionResume=yes (thread/resume), sessionFork=yes (thread/fork), slashCommands=no, mcp=yes, costTracking=yes.

**Key advantage**: Thread management (start, resume, fork, rollback, archive, compact) gives session control comparable to OpenCode.

**Note**: If Codex adds ACP support, this adapter could be replaced by ACPAdapter. However, the rich thread management API may justify keeping a dedicated adapter.

### GeminiCliAdapter (Headless + A2A)

**Approach**: Dual-mode — headless for simple use, A2A for inter-agent communication.

```
# Headless mode
createSession(): spawn `gemini -p --output-format stream-json`
send(): write to stdin
messages(): parse NDJSON stream → translate to UnifiedMessage

# A2A mode (for multi-agent)
createSession(): connect to A2A server endpoint
send(): JSON-RPC 2.0 task request
messages(): consume A2A task updates
```

**Protocol**: NDJSON stream (headless) or JSON-RPC 2.0 (A2A).

**Capabilities**: streaming=yes, interrupt=yes, modelSwitching=yes, slashCommands=yes, mcp=yes, structuredOutput=yes, imageInput=yes.

**Note**: Gemini CLI also supports ACP — the ACPAdapter could be used instead.

### PtyAdapter (Universal Fallback)

**Approach**: Expand current PtyCommandRunner into a full adapter. Spawn any CLI in a PTY, send keystrokes, parse ANSI output.

```
createSession(): spawn CLI in PTY, handle trust/permission prompts
send(): proc.write(message + "\r")
messages(): ANSI-strip output, heuristic detection of tool calls/results/errors
interrupt(): proc.write("\x03") // Ctrl+C
```

**Protocol**: Raw PTY (keystrokes in, ANSI out).

**Capabilities**: Everything the TUI supports, but all heuristic-based. Fragile across CLI version updates.

**When to use**: Fallback for features not exposed in official APIs. Slash commands (current use). Agents with no server mode or ACP support (Aider, Cursor, Amp, Trae).

---

## ACP Integration Architecture

The bridge should serve dual roles in the ACP ecosystem:

### As ACP Client (consuming ACP agents)

```
┌─────────────────────────┐
│  SessionBridge           │ ←── WebSocket consumers (browser, mobile)
│  (multi-consumer, RBAC)  │
└──────────┬──────────────┘
           │
   ACPAdapter (ACP Client)
           │
    JSON-RPC 2.0 / stdio
           │
┌──────────┴──────────────┐
│  ACP Agent (subprocess)  │
│  (Goose, Kiro, Gemini,   │
│   Cline, OpenHands, etc.) │
└─────────────────────────┘
```

The ACPAdapter implements the BackendSession interface by translating to/from ACP JSON-RPC messages. This gives every ACP agent WebSocket remote access through the bridge.

### As ACP Server (exposing sessions to editors)

```
┌──────────────────────────┐
│  ACP-Compatible Editor    │
│  (Zed, JetBrains, Neovim) │
└──────────┬───────────────┘
           │
    JSON-RPC 2.0 / stdio
           │
┌──────────┴──────────────┐
│  ACP Server Endpoint     │ ←── NEW: Translates ACP → bridge protocol
│  (in bridge process)     │
└──────────┬──────────────┘
           │
   SessionBridge (existing)
           │
   Any BackendAdapter
           │
   Any Coding Agent CLI
```

This allows editors to use the bridge as an ACP agent, gaining bridge features (multi-consumer, history, relay) transparently. The ACP server translates `session/prompt` to `send()`, streams `session/update` from `messages()`, and handles `session/request_permission` via `respondToPermission()`.

---

## Daemon & Relay Architecture

For remote access (mobile → home desktop), a daemon keeps agent sessions alive while clients connect/disconnect, and a relay provides network connectivity.

### Daemon Architecture Patterns

#### Pattern 1: Happy Coder — Cloud Relay Model

**Source**: [Happy daemon](https://github.com/slopus/happy/blob/bb7a1173/packages/happy-cli/src/daemon/run.ts)

```
[Mobile App] --Socket.IO--> [Happy Cloud Server] --Socket.IO--> [Daemon]
                                  |                                 |
                            (Postgres, Redis)              (spawns detached)
                                                                   |
                                                          [Claude/Codex/Gemini]
                                                             (child processes)
```

**How the daemon works**:

1. **Acquires exclusive lock** via `O_CREAT | O_EXCL` on `daemon.lock`
2. **Starts local Fastify HTTP control server** on `127.0.0.1:0` (random port)
3. **Connects to Happy cloud server** via Socket.IO (machine-scoped WebSocket)
4. **Registers RPC handlers**: `spawn-happy-session`, `stop-session`, `stop-daemon`
5. **Runs heartbeat loop** every 60s (prune dead sessions, version check, write state)
6. **Starts caffeinate** to prevent macOS sleep

**Session spawning**:
- Detached child processes (`spawnHappyCLI(args, { detached: true })`)
- Sessions survive daemon restarts
- Webhook-based session registration: spawned sessions call back to daemon's HTTP endpoint (`POST /session-started`) with session ID
- tmux integration: `TmuxUtilities.spawnInTmux()` with PID tracking via `-P -F '#{pane_pid}'`

**Mobile connection path**: Mobile clients do NOT connect directly to the daemon. They connect to the Happy cloud server, which relays RPC commands. All data is E2E encrypted (TweetNaCl XSalsa20-Poly1305 + AES-256-GCM with per-session data encryption keys).

**Socket.IO configuration**: Path `/v1/updates`, transports `['websocket', 'polling']`, three connection scopes: `user-scoped` (mobile), `session-scoped` (agent sessions), `machine-scoped` (daemon).

**State persistence**:
- `daemon.state.json`: PID, HTTP port, start time, CLI version, heartbeat timestamp
- `daemon.lock`: PID for exclusive instance control
- Server-side: all session data in Postgres as encrypted blobs

#### Pattern 2: tmux — Pure Local Client-Server

```
tmux server (single process, persists)
  |-- Session 1 → Window 1 → Pane 1 (PTY → claude)
  |                         → Pane 2 (PTY → shell)
  |-- Session 2 → Window 1 → Pane 1 (PTY → codex)

tmux client 1 (attaches via Unix socket /tmp/tmux-{UID}/default)
tmux client 2 (attaches to same session — multiple viewers)
```

**Key properties**:
- Server auto-starts when first client connects
- Server persists when all clients disconnect
- Unix domain socket for IPC
- PTY file descriptors owned by server
- Multiple clients can view/interact with same session simultaneously
- Maps directly to coding agent sessions: `new -s agent` / `attach -t agent` / `detach` / `kill-session`

**Why this matters**: tmux is the gold standard for process persistence. Happy uses it for spawning agent sessions. Claude Code uses it for agent teams (tmux mode). The bridge's daemon should compose with tmux, not replace it.

#### Pattern 3: Goose — Local Daemon + Tunnel

**Source**: [goosed agent.rs](https://github.com/block/goose/blob/9b6669a0/crates/goose-server/src/commands/agent.rs)

```
[iOS App] --HTTPS--> [Cloudflare Worker] --WebSocket--> [goosed]
                                                            |
[Desktop App] --HTTP--> [goosed (localhost:port)]        [Agent]
                            |                           (in-process)
                      (SessionManager)
```

**Architecture**:
- Axum HTTP server with REST endpoints (`/sessions`, `/reply`, `/agent`)
- `AgentManager` + `SessionManager` for session CRUD (persisted in SQLite)
- Optional "lapstone" tunnel: WebSocket to Cloudflare Worker relay
- Tunnel authentication via `X-Secret-Key` header with constant-time comparison
- Watchdog task: auto-restarts tunnel WebSocket with exponential backoff
- File locking: `tunnel.lock` prevents duplicate tunnel instances

**Tunnel is the simplest remote access model** — the daemon's local HTTP API is transparently exposed through the tunnel. No cloud server infrastructure needed.

#### Pattern 4: SSH ControlMaster — Connection Reuse

```
ssh (first connection, becomes master)
  |-- Creates Unix socket at ControlPath (~/.ssh/control-%h-%p-%r)
  |-- Holds TCP connection to remote host
  |-- ControlPersist: keeps master alive after all clients disconnect

ssh (second connection)
  |-- Detects Unix socket
  |-- Sends session through existing master connection
  |-- No new TCP handshake, no new authentication
```

`ControlPersist` keeps the master connection alive for a configurable period after the last client disconnects — exactly the pattern needed for coding agent sessions.

#### Pattern 5: Mosh — Stateless Sync Over UDP

```
[mosh client] --UDP--> [mosh-server]
      |                      |
 [SSP: Screen sync]    [SSP: Keystroke sync]
      |                      |
 [local prediction]     [terminal emulator]
```

**Key architecture**: State Synchronization Protocol (SSP) over UDP. Syncs terminal screen state objects rather than byte streams. AES-128 in OCB3 mode per datagram. IP roaming (WiFi → cellular) without reconnection. Adaptive frame rate based on network conditions.

### Daemon Architecture Comparison

| Component | Happy | Goose | tmux | SSH ControlMaster |
|-----------|-------|-------|------|-------------------|
| **Session Manager** | `pidToTrackedSession` Map | `AgentManager` + `SessionManager` | Server owns all sessions | N/A |
| **Connection Manager** | `EventRouter` + Socket.IO | Axum HTTP routes | Unix socket, multiple clients | Unix socket multiplexing |
| **Transport** | Socket.IO (WS) via cloud relay | HTTP/REST + WebSocket tunnel | Unix domain socket | TCP over SSH channel |
| **Process Isolation** | Detached child processes / tmux | tokio tasks (in-process) | PTY per pane | Channels in master connection |
| **State Persistence** | `daemon.state.json` + Postgres | SQLite | In-memory (server process) | Unix socket file |
| **Auth** | Public key + Bearer + E2E encryption | `X-Secret-Key` header | File permissions | SSH key/password |
| **Health/Liveness** | 60s heartbeat + version check | N/A (relies on OS) | N/A (server stays alive) | `ControlPersist` timeout |
| **Lock Mechanism** | `O_CREAT\|O_EXCL` lock file | `fs2::try_lock_exclusive` | Server socket path | Socket file existence |

### The Minimal Viable Daemon

A coding agent daemon needs exactly five things:

1. **Process Supervisor**: Spawn and track agent processes (by PID). Handle their exit. Ensure exclusive lock (only one daemon per machine).

2. **Local Control API**: HTTP or Unix socket on localhost for listing sessions, spawning new ones, stopping existing ones. (Happy uses Fastify on `127.0.0.1:0`, Goose uses Axum on configurable port.)

3. **State File**: Simple JSON `{ pid, port, version, heartbeat }` for other CLI invocations to discover and communicate with the running daemon.

4. **Signal Handling**: Graceful shutdown on SIGTERM/SIGINT with cleanup of state and lock files.

5. **Optional Relay Connection**: Outbound WebSocket/HTTP to a cloud relay or tunnel for remote access.

### Where Does the Relay Sit?

The relay is architecturally separate from the daemon, but may be embedded in the same process. Three patterns:

```
MODEL 1: Cloud Relay (Happy)
═══════════════════════════════
  [Mobile] --Socket.IO--> [Cloud Server] --Socket.IO--> [Daemon]
                               |
                         (auth, routing,
                          persistence,
                          multi-device sync)

  Pros: Works from anywhere, multi-device, server-side persistence
  Cons: Requires cloud infrastructure, added latency, operational cost


MODEL 2: Embedded Tunnel (Goose)
═══════════════════════════════
  [iOS App] --HTTPS--> [Cloudflare Worker] --WS--> [Daemon (goosed)]

  Pros: Local-first, zero-infra, simple
  Cons: No multi-device sync, tunnel = single point of failure


MODEL 3: External Tunnel (cloudflared/ngrok)
═══════════════════════════════
  [Mobile] --HTTPS--> [cloudflared edge] --tunnel--> [Daemon (bridge)]

  Pros: Zero code changes to daemon, battle-tested infrastructure
  Cons: Requires install/config of tunnel tool, less control
```

### Recommended Architecture: Pluggable Daemon + Relay

```
[Remote Client]
      |
      v
[Relay Layer] ◄── pluggable: cloud server / tunnel / direct
      |
      v
[Daemon] ◄── local process, manages sessions
   |
   |-- [Local Control API] (HTTP on localhost)
   |-- [Session Manager] (PID tracking, spawn/stop)
   |-- [State File] (discovery + heartbeat)
   |
   v
[Agent Process(es)] ◄── detached, or in tmux windows
```

**DaemonAdapter Interface** (abstraction over daemon patterns):

```typescript
interface DaemonAdapter {
  /** Unique identifier: "direct" | "tmux" | "detached" */
  readonly type: string

  /** Spawn an agent session, return PID and session metadata */
  spawnSession(options: SpawnOptions): Promise<SpawnResult>

  /** Stop a running session */
  stopSession(sessionId: string): Promise<void>

  /** List all managed sessions */
  listSessions(): Promise<DaemonSessionInfo[]>

  /** Check if a session is alive */
  isAlive(pid: number): boolean

  /** Cleanup resources */
  dispose(): Promise<void>
}

interface SpawnOptions {
  agent: 'claude' | 'codex' | 'gemini' | 'goose' | string
  cwd: string
  env?: Record<string, string>
  model?: string
  permissionMode?: string
  detached?: boolean  // survive daemon restart
}

interface SpawnResult {
  pid: number
  sessionId: string
  tmuxSession?: string  // if spawned in tmux
}

interface DaemonSessionInfo {
  sessionId: string
  pid: number
  agent: string
  cwd: string
  state: 'starting' | 'running' | 'exited'
  tmuxSession?: string
  startedAt: number
}
```

**RelayAdapter Interface** (abstraction over relay patterns):

```typescript
interface RelayAdapter {
  /** Relay type: "direct" | "tunnel" | "cloud" */
  readonly type: string

  /** Start relay connection */
  connect(options: RelayOptions): Promise<void>

  /** Check if relay is connected */
  readonly isConnected: boolean

  /** Get the public URL for remote access */
  readonly publicUrl: string | null

  /** Stop relay connection */
  disconnect(): Promise<void>
}

interface RelayOptions {
  /** Local HTTP port to expose */
  localPort: number
  /** Auth token for relay */
  authToken?: string
  /** For cloud relay: server URL */
  serverUrl?: string
  /** For tunnel: tunnel service */
  tunnelService?: 'cloudflared' | 'ngrok' | 'lapstone'
}
```

**Implementations**:

| DaemonAdapter | Description | Use Case |
|---------------|-------------|----------|
| `DirectDaemonAdapter` | Manages detached child processes | Simple, no tmux dependency |
| `TmuxDaemonAdapter` | Spawns in tmux sessions/windows | Process visibility, multi-viewer |
| `HybridDaemonAdapter` | Detached + tmux fallback | Auto-detect best option |

| RelayAdapter | Description | Use Case |
|-------------|-------------|----------|
| `DirectRelayAdapter` | No relay, localhost only | Local development |
| `TunnelRelayAdapter` | Shell out to cloudflared/ngrok | Simple remote access |
| `CloudRelayAdapter` | Socket.IO to cloud server | Full-featured remote (Happy model) |
| `EmbeddedTunnelAdapter` | Built-in WebSocket tunnel | Goose-style, zero external deps |

### Relay Design Principles

1. **Bridge doesn't need to change** — relay is a transparent WebSocket proxy
2. **E2E encryption** — relay should not see message contents (Happy uses TweetNaCl + AES-256-GCM)
3. **Session routing** — relay maps session IDs to backend connections
4. **Authentication** — relay authenticates mobile device before proxying
5. **Presence** — relay forwards presence updates so mobile knows what's connected
6. **Outbound-only** — daemon initiates connection (no open inbound ports, like Cloudflare Tunnel)

### Minimal Relay (Phase 1)

The simplest relay: a WebSocket proxy that authenticates and forwards.

```
Mobile → wss://relay.example.com/ws/consumer/{sessionId}
  ↕ (authenticated, E2E encrypted payload)
Relay Server (stateless proxy)
  ↕ (forward to registered backend)
Home Desktop → wss://relay.example.com/ws/backend/{sessionId}
```

The bridge on the home desktop connects to the relay as a "backend client". The mobile app connects as a "consumer client". The relay routes messages between them based on session ID.

---

## Refactoring Phases

### Phase 1: Extract BackendAdapter Interface + ClaudeAdapter

- Define `BackendAdapter`, `BackendSession`, `UnifiedMessage`, `BackendCapabilities` types
- Extract current NDJSON/`--sdk-url` logic from SessionBridge into `ClaudeAdapter`
- ClaudeAdapter implements BackendSession with AsyncIterable
- SessionBridge consumes BackendSession.messages() instead of parsing raw NDJSON
- All existing tests continue to pass (behavioral equivalence)

### Phase 2: SessionBridge Becomes Backend-Agnostic

- Remove all NDJSON parsing from SessionBridge
- SessionBridge only knows about `UnifiedMessage`
- Consumer protocol unchanged (ConsumerMessage types stay the same)
- Add `backendType` to SessionState
- Factory function selects adapter based on config

### Phase 3: ACPAdapter (Strategic Priority)

- Implement ACP client adapter using TypeScript SDK
- Single adapter covers all ACP-compliant agents (Goose, Kiro, Cline, OpenHands, Gemini CLI)
- Capability negotiation during `initialize` populates BackendCapabilities dynamically
- This immediately expands supported backends from 1 to ~25+

### Phase 4: AgentSdkAdapter (Claude Code Official SDK)

- `AgentSdkAdapter` using `@anthropic-ai/claude-agent-sdk`
- Bridge the SDK's callback-based permission model to async message flow
- In-process execution (no subprocess needed for the adapter itself)
- Enables structured output, JSON schema validation

### Phase 5: OpenCodeAdapter (REST + SSE)

- HTTP client to `localhost:4096` (or remote OpenCode server)
- SSE event parsing → UnifiedMessage
- Leverage OpenCode's full API surface (fork, revert, diff, etc.)

### Phase 6: ACP Server Endpoint

- Expose bridge sessions via ACP JSON-RPC over stdio
- Any ACP-compatible editor (Zed, JetBrains, Neovim) can connect
- Translate ACP methods → SessionBridge calls → BackendAdapter
- Register in ACP agent registry

### Phase 7: Agent Teams Integration

- File watcher on `~/.claude/teams/` and `~/.claude/tasks/`
- Team-level consumer messages (teammate status, task list, inter-agent messages)
- Multi-session view in consumer protocol
- Aggregate cost/token tracking across team

### Phase 8: Daemon + Relay Layer

- `DaemonAdapter` interface with `DirectDaemonAdapter` and `TmuxDaemonAdapter`
- `RelayAdapter` interface with `DirectRelayAdapter` (local) and `TunnelRelayAdapter` (cloudflared/ngrok)
- Process supervisor: PID tracking, spawn/stop, heartbeat, exclusive lock
- Local control API: HTTP on localhost for session management
- WebSocket proxy relay with authentication and E2E encryption
- Session routing and presence forwarding

### Phase 9: Promote PTY to Full Adapter + Remaining Adapters

- Expand PtyCommandRunner into `PtyAdapter` for agents with no server mode
- `CodexAdapter` for JSON-RPC (or rely on ACPAdapter if Codex adds ACP)
- `GeminiCliAdapter` for headless/A2A (or rely on ACPAdapter)
- Fallback chain: try official adapter → ACP → PTY

---

## Alternatives Analysis: SSH + tmux

The baseline that everything competes against:

```bash
# On home desktop
tailscale up
tmux new-session -s claude
claude

# On mobile (Blink Shell / Termius)
ssh user@home-desktop.tailnet
tmux attach -t claude
```

### Advantages of SSH + tmux
- Zero dependencies beyond SSH and tmux
- Works with ANY CLI tool, not just coding agents
- Battle-tested, well-understood security model
- Sub-20ms latency on local network
- Mosh adds connection resilience

### Disadvantages (why build something better)
- **No structured data** — you see raw terminal output, can't parse tool calls/permissions
- **No multi-device** — only one tmux client has control (others are read-only or conflict)
- **No capability gating** — can't show/hide features based on backend
- **No mobile-optimized UI** — terminal on a phone is painful
- **No relay/notification** — must maintain VPN connection
- **No permission approval UI** — must type in terminal
- **No session management** — manual tmux session juggling
- **No presence** — can't see who else is watching
- **No message history replay** — join late, miss everything

### The Value Proposition

`claude-code-bridge` with the universal adapter layer provides everything SSH+tmux gives you (full CLI access via PTY fallback) PLUS:
- Structured message protocol for rich UIs
- Multi-consumer with RBAC and presence
- Backend-agnostic (swap Claude for OpenCode without changing frontend)
- ACP compatibility (works with ACP editors out of the box)
- Mobile-optimized consumer protocol
- Permission approval UI
- Session history and replay
- Capability negotiation
- Agent teams dashboard
- Relay-ready architecture

---

## Open Questions

1. **Should adapters be separate npm packages?** (e.g., `@claude-code-bridge/adapter-opencode`)
2. **How to handle adapter-specific features?** (e.g., OpenCode's session fork, SDK's structured output). Likely via capability flags + passthrough.
3. **Should the relay be part of this project or separate?**
4. **How to handle authentication across the relay?** (QR code pairing? OAuth? Shared secret?)
5. **ACP server: stdio-only or also support the draft HTTP/WS transport?** Watch RFC progress.
6. **How to version the UnifiedMessage schema as backends evolve?** Semver with backward-compatible additions.
7. **Should the ACPAdapter be the default for new agents, replacing agent-specific adapters?** Likely yes for most, with specific adapters only for features ACP doesn't cover.
8. **Agent teams: bridge-level coordination or passthrough?** Should the bridge just observe team state, or actively coordinate?
9. **Daemon: embed in bridge or separate process?** Happy and Goose both use separate daemon processes. Could the bridge itself serve as the daemon, or should there be a thin daemon wrapper that launches bridge instances?
10. **Daemon: tmux dependency or standalone?** Should the daemon require tmux for process persistence, or implement its own detached process management? tmux gives multi-viewer for free but adds a dependency.
11. **Relay: Happy model (cloud) vs Goose model (tunnel)?** Cloud relay gives multi-device sync and persistence but requires infrastructure. Tunnel is simpler but loses those features. Could support both via `RelayAdapter` interface.
12. **Subagent observability: file watcher or hooks?** For agent teams, the bridge needs real-time updates. File system watching (`~/.claude/teams/`) vs hook scripts that POST to bridge HTTP endpoint. Hooks are more reliable but require configuration; file watching is automatic but can miss events.

---

## References

### Protocols
- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) — [GitHub](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP Go SDK (Coder)](https://github.com/coder/acp-go-sdk)
- [Agent-to-Agent Protocol (A2A)](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) — [Linux Foundation](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — [Go SDK](https://github.com/modelcontextprotocol/go-sdk)

### Agent SDKs & Server Modes
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK Python Source](https://github.com/anthropics/claude-agent-sdk-python) — [subprocess_cli.py](https://github.com/anthropics/claude-agent-sdk-python/blob/4d747482/src/claude_agent_sdk/_internal/transport/subprocess_cli.py), [client.py](https://github.com/anthropics/claude-agent-sdk-python/blob/4d747482/src/claude_agent_sdk/_internal/client.py), [query.py](https://github.com/anthropics/claude-agent-sdk-python/blob/4d747482/src/claude_agent_sdk/_internal/query.py)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code on the Web / Teleport](https://code.claude.com/docs/en/claude-code-on-the-web)
- [SDK Subagents Documentation](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [SDK Streaming Documentation](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [OpenCode Server Docs](https://opencode.ai/docs/server/) — [SDK](https://opencode.ai/docs/sdk/)
- [Gemini CLI Headless Mode](https://geminicli.com/docs/cli/headless/)
- [Gemini CLI SDK](https://www.npmjs.com/package/@google/gemini-cli-sdk)

### ACP Adapters & Integrations
- [claude-code-acp (Zed adapter)](https://github.com/zed-industries/claude-code-acp)
- [JetBrains ACP Documentation](https://www.jetbrains.com/help/ai-assistant/acp.html)
- [Kiro CLI ACP Documentation](https://kiro.dev/docs/cli/acp/)
- [ACP Community Agents Registry](https://github.com/agentclientprotocol/registry)
- [Goose ACP Introduction](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/)

### Daemon & Relay Architecture
- [Happy Coder](https://github.com/slopus/happy) — [daemon/run.ts](https://github.com/slopus/happy/blob/bb7a1173/packages/happy-cli/src/daemon/run.ts), [encryption.md](https://github.com/slopus/happy/blob/bb7a1173/docs/encryption.md), [backend-architecture.md](https://github.com/slopus/happy/blob/bb7a1173/docs/backend-architecture.md)
- [Goose](https://github.com/block/goose) — [agent.rs](https://github.com/block/goose/blob/9b6669a0/crates/goose-server/src/commands/agent.rs), [lapstone.rs](https://github.com/block/goose/blob/9b6669a0/crates/goose-server/src/tunnel/lapstone.rs)
- [OpenCode](https://github.com/opencode-ai/opencode) — monolithic TUI, no daemon mode (as of commit 73ee493)
- [Mosh: Mobile Shell](https://mosh.org/) — [USENIX Paper](https://mosh.org/mosh-paper.pdf) — State Synchronization Protocol over UDP
- [ttyd](https://github.com/tsl0922/ttyd) — PTY wrapped in WebSocket (libwebsockets)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — outbound-only QUIC/HTTP2 tunnel
- [SSH Multiplexing and Master Mode](https://oooops.dev/2021/01/31/ssh-multiplexing-and-master-mode/)

### Subagent & Team Architecture
- [DeepWiki: Claude Code Agent System](https://deepwiki.com/anthropics/claude-code/3.1-agent-system-and-subagents)
- [Swarm Orchestration Skill](https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea)
- [From Tasks to Swarms](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
- [Claude Code Swarms](https://addyosmani.com/blog/claude-code-agent-teams/) — Addy Osmani
- [Task Tool vs Subagents](https://www.ibuildwith.ai/blog/task-tool-vs-subagents-how-agents-work-in-claude-code)

### Competitive Landscape
- [The Companion](https://github.com/The-Vibe-Company/companion)
- [Happy Coder](https://github.com/slopus/happy)
- [Harper Reed: Claude Code on Phone](https://harper.blog/2026/01/05/claude-code-is-better-on-your-phone/)
