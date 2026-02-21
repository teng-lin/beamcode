# beamcode

Code from anywhere. Collaborate on any agent session. Drive Claude, Codex, OpenCode, Gemini, Goose, or any CLI agent from your phone, tablet, or laptop — and let teammates watch, join, and catch up in real time.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   Your computer (work/home)       You (anywhere, any device)        │
  │   ┌─────────────┐                ┌──────────────────┐               │
  │   │ Claude Code │                │ Phone / Tablet   │               │
  │   │ (running)   │                │ Laptop Browser   │◄── E2E encrypted
  │   └──────┬──────┘                └────────┬─────────┘   via CF Tunnel
  │          │                                │                         │
  │          │   ┌────────────────────────────┤                         │
  │          │   │                            │                         │
  │          ▼   ▼                            │                         │
  │   ┌──────────────┐                        │  Teammate    Observer   │
  │   │  BeamCode    │◄───────────────────────┤  ┌────────┐  ┌───────┐  │
  │   │  fan-out,    │                        └──│ Laptop │  │ Audit │  │
  │   │  RBAC,replay │◄──────────────────────────│(collab)│  │(watch)│  │
  │   └──────────────┘                           └────────┘  └───────┘  │
  │                                                                     │
  │   N consumers ↔ 1 agent session (not 1:1 like everything else)      │
  └─────────────────────────────────────────────────────────────────────┘
```

## Why this matters

There are 30+ projects in this space — Companion, Happy, ClaudeCodeUI, Opcode, CUI, and others. They all share two limitations:

1. **1:1 sessions** — one frontend, one CLI backend. No collaboration.
2. **SSH/tmux/Tailscale plumbing** — remote access is a DIY stack, not a product.

BeamCode solves both.

**Code from anywhere** — Cloudflare Tunnel + E2E encryption turns your desktop agent into something you can drive from any device. No open ports, no VPN, no SSH. Open a link on your phone and you're in.

**Collaborate on the same session** — BeamCode sessions are N:1, not 1:1:

- **N consumers per session** — `Map<WebSocket, ConsumerIdentity>`, not a single slot
- **Role gating** — participants drive, observers watch (PARTICIPANT_ONLY message types)
- **Fan-out broadcasts** — every consumer gets every message, filtered by role
- **Presence** — everyone sees who joins and leaves in real time
- **History replay** — late joiners catch up from message history
- **Protocol-agnostic** — same multi-consumer model whether the backend is Claude, Goose, or Codex

This unlocks scenarios no existing tool supports:

| Scenario | How it works |
|----------|-------------|
| **Code from anywhere** | Start Claude at work or home, drive it remotely from your phone, tablet, or laptop via encrypted tunnel |
| **Pair programming with AI** | One person drives Claude, others observe and learn |
| **Real-time code review** | Reviewer watches the agent work, sees permission requests live |
| **Teaching / onboarding** | Instructor drives, students observe the full agent workflow |
| **Audit trail** | Security observer watches agent actions without ability to interfere |

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                       CONSUMERS                          │
│  Mobile Browser │ Web UI │ Telegram │ Discord │ Terminal │
└────────┬────────────┬──────────┬─────────┬───────────────┘
         └────────────┴────┬─────┴─────────┘
                           │
                Consumer Protocol (JSON/WS)
                           │
           ┌───────────────┴────────────────┐
           │          BeamCode              │
           │  fan-out · RBAC · replay       │
           └───────────────┬────────────────┘
                           │
                 BackendAdapter interface
                           │
              ┌────────────┼────────────┬────────────┬─────────┐
              │            │            │            │         │
           Claude        ACP          Codex      Opencode   Your
           Adapter       Adapter      Adapter    Adapter    Adapter
              │            │            │            │         │
           Claude        Goose        Codex      Opencode   any
           Code          Kiro         CLI        CLI        agent
           --sdk-        Gemini       (OpenAI)
           url           Cline
                         25+ agents
```

## Features

- **Multi-consumer sessions**: N frontends per session with fan-out, RBAC, presence, and history replay
- **Multi-agent support**: Adapters for Claude Code (`--sdk-url`), Codex CLI (JSON-RPC), OpenCode (REST+SSE), Gemini CLI (via ACP), and ACP backends (25+ agents)
- **Web UI**: Companion-style interface with real-time streaming, permission handling, slash commands, and team coordination
- **E2E encryption**: libsodium sealed boxes (XSalsa20-Poly1305) with pairing link key exchange
- **Remote access**: Cloudflare Tunnel — no open ports, no VPN, no SSH
- **Daemon**: Process supervisor that keeps sessions alive across client reconnects
- **Reconnection**: Sequenced messages with replay from `last_seen_seq` on reconnect
- **Pluggable auth**: Transport-agnostic `Authenticator` interface (JWT, API keys, cookies, mTLS)
- **Permission signing**: HMAC-SHA256 with nonce + timestamp to prevent replay attacks
- **Production hardened**: Rate limiting, circuit breaker, backpressure, structured logging

## Requirements

- Node.js >= 22.0.0
- A coding agent CLI installed (Claude Code, Codex, Gemini CLI, Goose, etc.)
- For relay: `cloudflared` binary in PATH

## Installation

```sh
npm install -g beamcode
# or
pnpm add -g beamcode
```

## Quick Start

### Start the server

```sh
beamcode
```

This starts the BeamCode server on port 9414. Open `http://localhost:9414` in your browser to access the web UI.

For development from source:

```sh
pnpm build && pnpm start
```

### Web UI

The web UI is a React 19 app served directly from the BeamCode server. Open your browser to `http://localhost:9414`.

**What you get:**

- **Session list** — collapsible sidebar showing all agent sessions grouped by date, with adapter badges (Claude Code, Codex, Gemini CLI, etc.)
- **Chat view** — streaming message feed with 3-level grouping (content-block → message → subagent), rich markdown rendering, thinking blocks, and tool execution visualization
- **Composer** — message input with `/slash` command menu and keyboard shortcuts
- **Permission UI** — inline banners for tool permission requests with context-aware previews (Bash commands, file diffs, paths)
- **Status bar** — adapter type, active model, git branch, context gauge, circuit breaker status
- **Team panel** — agent grid, task list, and member presence for multi-agent sessions
- **New session dialog** — create sessions with adapter, model, and working directory selection
- **Process logs** — raw CLI output drawer for debugging

To start with hot-module replacement during frontend development:

```sh
# Terminal 1
pnpm start          # BeamCode server on :9414

# Terminal 2
pnpm dev:web        # Vite dev server on :5174 (proxies to :9414)
```

Then open `http://localhost:5174`.

## Security

- **E2E encryption**: libsodium sealed boxes (XSalsa20-Poly1305) — relay cannot read message contents
- **Permission signing**: HMAC-SHA256 + nonce + timestamp prevents replay
- **Session revocation**: `revoke-device` generates new keypair, forces re-pairing
- **Binary validation**: agent binaries must be a basename or absolute path (no `../`)
- **Env deny list**: `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS` always blocked
- **Rate limiting**: Token bucket per consumer (configurable)
- **Circuit breaker**: Sliding window prevents CLI restart cascades

See [SECURITY.md](./SECURITY.md) for the full threat model and cryptographic details.

## Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md) — Architecture, adapters, configuration, events, testing
- [docs/architecture.md](./docs/architecture.md) — End-to-end system diagram and module map
- [SECURITY.md](./SECURITY.md) — Threat model and cryptographic details

## License

MIT
