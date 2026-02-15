# Architecture Diagram: Relay-First MVP

**Based on**: `docs/architecture/decisions.md` v2.1 (Relay-First MVP, post-review revision)
**Date**: 2026-02-15

---

## Strategic Overview

```
  v1 (Library-First)              v2.1 (Relay-First)            Parallel Tracks (2 eng)
  ─────────────────               ──────────────────            ───────────────────────

  Design abstractions             Build relay MVP               ┌─ Track 1: Adapters ───┐
        │                               │                       │  SdkUrl + ACP extract │
        ▼                               ▼                       │  (shapes interfaces)  │
  Build adapters (2-3)            Extract abstractions          └──────────┬────────────┘
        │                         from working code                       │ converge
        ▼                               │                       ┌─────────▼─────────────┐
  Hope relay fits                       ▼                       │  Track 2: Relay       │
  (10% ever ships)                Widen to other adapters       │  Daemon + Tunnel + E2E│
                                  (validated by ACP + Codex)    └───────────────────────┘

  12-14 weeks                     17-22 weeks (1 eng)           13-15 weeks (2 eng)
  Wrong thing, on time            Right thing, slower            Right thing, on time
```

---

## Target Architecture (v2.1)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        RELAY-FIRST MVP ARCHITECTURE (v2.1)                          │
│                                                                                     │
│  ╔════════════════╗  ╔═══════════╗                                                  │
│  ║ Minimal Web    ║  ║  Desktop  ║  Consumers                                       │
│  ║ Consumer       ║  ║  Browser  ║  (any WebSocket client)                          │
│  ║ (500-1000 LOC) ║  ╚═════╤═════╝                                                  │
│  ║ E2E decrypt,   ║        │                                                        │
│  ║ render, input  ║        │  ws://localhost                                        │
│  ╚═══════╤════════╝        │  (direct, no tunnel)                                   │
│          │                 │                                                        │
│          │  HTTPS          │                                                        │
│          │                 │                                                        │
│  ┌───────▼─────────┐       │                                                        │
│  │  Cloudflare     │       │                                                        │
│  │  Tunnel Edge    │       │  LOCAL PATH                                            │
│  │  (SLA 99.99%)   │       │                                                        │
│  └───────┬─────────┘       │                                                        │
│          │                 │                                                        │
│  ┌───────▼─────────┐       │                                                        │
│  │  cloudflared    │       │  ◄── sidecar process (Go binary)                       │
│  │  reverse proxy  │       │      proxies HTTPS → localhost:PORT                    │
│  └───────┬─────────┘       │                                                        │
│          │ localhost:PORT  │                                                        │
│          │                 │                                                        │
│  ┌───────▼─────────────────▼─────────────────────────────────────────┐              │
│  │                        DAEMON (localhost)                         │              │
│  │                                                                   │              │
│  │  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────────┐  │              │
│  │  │ Lock File │ │ State     │ │ Health   │ │ Local Control API  │  │              │
│  │  │ O_CREAT|  │ │ File      │ │ Check    │ │ HTTP 127.0.0.1:0   │  │              │
│  │  │ O_EXCL    │ │ PID, port │ │ 60s loop │ │                    │  │              │
│  │  │           │ │ heartbeat │ │          │ │ • list sessions    │  │              │
│  │  │           │ │ version   │ │          │ │ • create session   │  │              │
│  │  │           │ │           │ │          │ │ • stop session     │  │              │
│  │  │           │ │           │ │          │ │ • revoke-device    │  │              │
│  │  └───────────┘ └───────────┘ └──────────┘ │ • rate-limit cfg   │  │              │
│  │                                           └────────────────────┘  │              │
│  │  ┌────────────────────────────────────────────────────────────┐   │              │
│  │  │         Child-Process Supervisor (~50% reusable)           │   │              │
│  │  │                                                            │   │              │
│  │  │  Reusable:  CLILauncher (548 LOC) — lifecycle, PID, crash  │   │              │
│  │  │             SessionManager (340 LOC) — relaunch, reconnect │   │              │
│  │  │             FileStorage (213 LOC) — atomic writes, WAL     │   │              │
│  │  │             ProcessManager — spawn, kill, isAlive          │   │              │
│  │  │                                                            │   │              │
│  │  │  NEW:       Lock file, state file, HTTP control API        │   │              │
│  │  │             Signal handling, graceful shutdown             │   │              │
│  │  │                                                            │   │              │
│  │  │  CLI processes are child processes (die with daemon).      │   │              │
│  │  │  Session STATE persists via FileStorage (restored on       │   │              │
│  │  │  restart). No tmux — no runtime dep, no port problem.      │   │              │
│  │  └───────────────────┬────────────────────────────────────────┘   │              │
│  │                      │ manages child processes                    │              │
│  └──────────────────────┼────────────────────────────────────────────┘              │
│                         │                                                           │
│                         ▼                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐               │
│  │                   E2E ENCRYPTION LAYER                           │               │
│  │                                                                  │               │
│  │  ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐  │               │
│  │  │ libsodium      │ │ Pairing Link   │ │ HMAC-SHA256          │  │               │
│  │  │ Sealed Boxes   │ │ Key Exchange   │ │ Permission Signing   │  │               │
│  │  │ XSalsa20-      │ │ (URL with      │ │ + nonce              │  │               │
│  │  │ Poly1305       │ │  public key +  │ │ + timestamp (30s)    │  │               │
│  │  │                │ │  tunnel addr)  │ │ + request_id binding │  │               │
│  │  └────────────────┘ └────────────────┘ └──────────────────────┘  │               │
│  │                                                                  │               │
│  │  ┌────────────────────┐  ┌──────────────────────────────────┐    │               │
│  │  │ Session Revocation │  │ EncryptedEnvelope (wire format)  │    │               │
│  │  │ • revoke-device    │  │ {                                │    │               │
│  │  │ • new keypair      │  │   v:   1,       // protocol ver  │    │               │
│  │  │ • force re-pair    │  │   sid: "abc",   // routing       │    │               │
│  │  └────────────────────┘  │   ct:  "...",   // ciphertext    │    │               │
│  │                          │   len: 1234     // plaintext len │    │               │
│  │  TUNNEL-BLIND: relay cannot decrypt message contents.       │    │               │
│  │  Bridge CAN see plaintext (needed for CLIMsg→ConsumerMsg).  │    │               │
│  │  Protects against: tunnel/Cloudflare compromise.            │    │               │
│  │  Does NOT protect against: local bridge compromise.         │    │               │
│  └──────────────────────────────────────────────────────────────────┘               │
│                         │                                                           │
│                         ▼                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐               │
│  │                     server/ (WebSocket)                          │               │
│  │                                                                  │               │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │               │
│  │  │ Origin       │  │ Auth Token   │  │ Reconnection Handler   │  │               │
│  │  │ Validation   │  │ Gate         │  │                        │  │               │
│  │  │ (Phase 0)    │  │ (Phase 0)    │  │  Stable consumer IDs   │  │               │
│  │  └──────────────┘  └──────────────┘  │  (survive reconnect)   │  │               │
│  │                                      │                        │  │               │
│  │  ┌──────────────┐  ┌──────────────┐  │  SequencedMessage<T>   │  │               │
│  │  │ Consumer     │  │ Backpressure │  │  seq tracking          │  │               │
│  │  │ Rate Limit   │  │ Per-consumer │  │  Message replay        │  │               │
│  │  │ 10 msg/s     │  │ send queues  │  │  History pagination    │  │               │
│  │  │ 100 KB/s     │  │ + high-water │  │  (last 20, scroll)     │  │               │
│  │  └──────────────┘  └──────────────┘  └────────────────────────┘  │               │
│  └───────────────────────────┬──────────────────────────────────────┘               │
│                              │                                                      │
│             ConsumerMessage (with message_id, seq, timestamp)                       │
│                              │                                                      │
│                              ▼                                                      │
│  ┌──────────────────────────────────────────────────────────────────┐               │
│  │                  core/SessionBridge                              │               │
│  │                                                                  │               │
│  │  ╔════════════════════════════════════════════════════════════╗  │               │
│  │  ║                    UnifiedMessage                          ║  │               │
│  │  ║  Designed for SdkUrl (streaming), ACP (request/resp),      ║  │               │
│  │  ║  AND Codex (Thread/Turn/Item JSON-RPC)                     ║  │               │
│  │  ║  + metadata escape hatch for adapter-specific data         ║  │               │
│  │  ║  + message_id + seq from day one                           ║  │               │
│  │  ║  Abort: > 2 changes during Phase 3 → redesign              ║  │               │
│  │  ╚════════════════════════════════════════════════════════════╝  │               │
│  │                                                                  │               │
│  │  ┌────────────────┐  ┌───────────────┐  ┌──────────────────┐     │               │
│  │  │ CoreSession    │  │ Authenticator │  │ SessionStorage   │     │               │
│  │  │ State          │  │ (E2E keypair  │  │ (FileStorage)    │     │               │
│  │  │ (serializable) │  │  for MVP)     │  │ (encrypt at rest │     │               │
│  │  └────────────────┘  └───────────────┘  │  DEFERRED)       │     │               │
│  │                                         └──────────────────┘     │               │
│  │  ┌──────────────────────────────────────────────────────────┐    │               │
│  │  │          BackendAdapter interface (CORE)                 │    │               │
│  │  │  connect(): BackendSession                               │    │               │
│  │  │  capabilities: BackendCapabilities {                     │    │               │
│  │  │    availability: "local" | "remote" | "both"             │    │               │
│  │  │  }                                                       │    │               │
│  │  ├──────────────────────────────────────────────────────────┤    │               │
│  │  │          BackendSession interface (CORE)                 │    │               │
│  │  │  send(msg): void                                         │    │               │
│  │  │  messages: AsyncIterable<UnifiedMessage>                 │    │               │
│  │  │  close(): void                                           │    │               │
│  │  ├──────────────────────────────────────────────────────────┤    │               │
│  │  │          COMPOSED EXTENSIONS (additive, not baked in)    │    │               │
│  │  │  Interruptible:     interrupt(): void                    │    │               │
│  │  │  Configurable:      setModel(), setPermissionMode()      │    │               │
│  │  │  PermissionHandler: request/response bridging            │    │               │
│  │  │  Reconnectable:     onDisconnect(), replay()    ← relay  │    │               │
│  │  │  Encryptable:       encrypt(), decrypt()        ← relay  │    │               │
│  │  └─────────────────────┬────────────────────────────────────┘    │               │
│  └────────────────────────┼─────────────────────────────────────────┘               │
│                           │                                                         │
│        ┌──────────────────┼──────────────────┬──────────────────┐                   │
│        │                  │                  │                  │                   │
│        ▼                  ▼                  ▼                  ▼                   │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ SdkUrl      │  │ ACP         │  │ Codex        │  │ AgentSdk     │               │
│  │ Adapter     │  │ Adapter     │  │ Adapter      │  │ Adapter      │               │
│  │             │  │             │  │              │  │              │               │
│  │ Phase 1     │  │ Phase 3     │  │ Phase 3      │  │ Phase 4      │               │
│  │ (extract)   │  │ (validate)  │  │ (validate)   │  │ (STRETCH)    │               │
│  │             │  │ must be by  │  │              │  │              │               │
│  │ NDJSON/WS   │  │ DIFFERENT   │  │ JSON-RPC/WS  │  │ Anthropic    │               │
│  │ --sdk-url   │  │ developer   │  │ app-server   │  │ Official SDK │               │
│  │             │  │       ┌─────┤  │              │  │              │               │
│  │             │  │       │ PTY │  │ Thread/Turn/ │  │              │               │
│  │             │  │       │side-│  │ Item model   │  │              │               │
│  │             │  │       │car  │  │ ~600-800 LOC │  │              │               │
│  └──────┬──────┘  └───┬───┴──┬──┘  └──────┬───────┘  └───────┬──────┘               │
│         │             │      │              │                │                      │
│         ▼             ▼      ▼              ▼                ▼                      │
│  ╔═══════════╗  ╔══════════╗    ╔═══════════════╗  ╔═══════════════╗                │
│  ║ Claude    ║  ║  Goose   ║    ║  Codex CLI    ║  ║   Anthropic   ║                │
│  ║ Code CLI  ║  ║  Kiro    ║    ║  (OpenAI)     ║  ║   API         ║                │
│  ║ (child)   ║  ║  Gemini  ║    ║               ║  ║               ║                │
│  ╚═══════════╝  ╚══════════╝    ╚═══════════════╝  ╚═══════════════╝                │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Remote Session (Relay MVP)

```
Web Consumer                   cloudflared (sidecar)          Daemon (localhost)
     │                         CF Tunnel Edge                       │
     │                               │                              │
     │  === ONE-TIME PAIRING ===     │                              │
     │                               │                              │
     │  1. Daemon generates keypair, │                              │
     │     prints pairing link:      │                              │
     │     https://tunnel.example.com/pair?pk=<base64>&v=1          │
     │                               │                              │
     │  2. User opens link on mobile │                              │
     │     Browser extracts daemon   │                              │
     │     public key from URL       │                              │
     │                               │                              │
     │  3. Browser generates own     │                              │
     │     keypair, sends public     │                              │
     │     key encrypted with        │                              │
     │     daemon's public key       │                              │
     │     (sealed box)              │                              │
     │                               │                              │
     │  === ENCRYPTED SESSION ===    │                              │
     │                               │                              │
     │  4. Send encrypted message    │                              │
     │  EncryptedEnvelope:           │                              │
     │  { v: 1,                      │                              │
     │    sid: "abc-123",            │                              │
     │    ct: "<sealed box>",        │                              │
     │    len: 42 }                  │                              │
     │                               │                              │
     ├──HTTPS─────────────────────►  │                              │
     │                               ├──localhost:PORT────────────► │
     │                               │   (reverse proxy)            │
     │  Tunnel sees ONLY:            │                              ├── decrypt(ct)
     │  { v, sid, ct, len }          │                              │   JSON.parse
     │  Cannot read ct contents      │                              │   InboundMessage
     │                               │                              │      │
     │                               │                              │   routeConsumerMsg
     │                               │                              │      │
     │                               │                              │   UnifiedMessage
     │                               │                              │      │
     │                               │                              │   SdkUrlAdapter
     │                               │                              │      │
     │                               │                              │   serializeNDJSON
     │                               │                              │      │
     │                               │                              │   Claude Code CLI
     │                               │                              │      │
     │                               │                              │   5. CLI response
     │                               │                              │ ◄────┘
     │                               │                              │   CLIMessage
     │                               │                              │   routeCLIMessage
     │                               │                              │   ConsumerMessage
     │                               │                              │   encrypt(msg)
     │                               │                              │      │
     │                               │   6. Encrypted response      │      │
     │                               │ ◄────────────────────────────┤──────┘
     │ ◄─────────────────────────────┤   EncryptedEnvelope          │
     │   7. decrypt, render          │   { v:1, sid:"abc-123",      │
     │                               │     ct:"<sealed>", len:340 } │
     │  Consumer sees:               │                              │
     │  { type: "assistant",         │                              │
     │    seq: 42,                   │                              │
     │    message_id: "msg_42",      │                              │
     │    message: {...} }           │                              │
```

---

## Pairing Link Flow (replaces QR code for MVP)

```
  DAEMON (terminal)                              MOBILE BROWSER
  ───────────────                                ──────────────

  1. Generate X25519 keypair
     pk = daemon public key
     sk = daemon secret key (sodium_malloc, mlock'd)

  2. Start cloudflared tunnel
     tunnel_url = https://random.cfargotunnel.com

  3. Print pairing link:
     ┌─────────────────────────────────────────────────┐
     │  beamcode: pairing link ready         │
     │                                                 │
     │  https://random.cfargotunnel.com/pair           │
     │    ?pk=<base64url(daemon_public_key)>           │
     │    &fp=<first 8 chars SHA256(pk)>               │
     │    &v=1                                         │
     │                                                 │
     │  Link expires in 60 seconds.                    │
     │  Fingerprint: a3f8 b2c1                         │
     └─────────────────────────────────────────────────┘
                    │
                    │  4. User copies link or types URL
                    │
                    ▼
              5. Browser extracts pk from URL params
              6. Browser generates own X25519 keypair
              7. Browser sends own public key to daemon
                 (encrypted with daemon pk via sealed box)
              8. Both sides now have each other's public keys
              9. All subsequent messages use crypto_box
                 (authenticated bidirectional E2E)

  POST-MVP UPGRADE:
  • QR code rendering in terminal (qrcode-terminal)
  • QR scanning via navigator.mediaDevices
  • Saves the "copy URL" step
```

---

## Reconnection Flow

```
Web Consumer                                   Daemon
     │                                           │
     │  Connected, receiving SequencedMessage<T> │
     │  seq: 38, 39, 40, 41...                   │
     │                                           │
     ╳  Network drops (WiFi → cellular)          │
     │                                           │
     │  (1-5 seconds)                            │  Messages 42, 43, 44
     │                                           │  queued in per-consumer
     │  Exponential backoff reconnect            │  send buffer (high-water mark)
     ├──────────────────────────────────────────►│
     │  { type: "reconnect",                     │
     │    consumer_id: "c_xyz",  ← stable ID     │
     │    session_id: "abc",                     │
     │    last_seen_seq: 41 }                    │
     │                                           │
     │  Look up consumer by ID (not socket ref)  │
     │  Replay from seq 42                       │
     │◄──────────────────────────────────────────┤
     │  { type: "reconnect_ack",                 │
     │    missed_count: 3 }                      │
     │  EncryptedEnvelope { sid, ct(seq:42) }    │
     │  EncryptedEnvelope { sid, ct(seq:43) }    │
     │  EncryptedEnvelope { sid, ct(seq:44) }    │
     │                                           │
     │  Resume normal flow                       │
     │  EncryptedEnvelope { sid, ct(seq:45) }    │
     │                                           │
     │  ─── BACKPRESSURE ───                     │
     │  If consumer falls behind:                │
     │  • Queue > high-water mark                │
     │  • Drop non-critical (stream_event)       │
     │  • Keep critical (permission_request)     │
     │  • If queue overflows → disconnect        │
```

---

## Implementation Phases (v2.1)

```
Week  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22
      ├──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤
      │     │           │                                │                 │
      │Ph 0 │  Phase 1  │         Phase 2                │    Phase 3      │
      │Found│  SdkUrl   │       RELAY MVP                │  Library + ACP  │
      │ation│  Extract  │      (6-8 weeks)               │  + Codex        │
      │     │           │                                │  (4-6 weeks)    │
      ├─────┤───────────┤────────────────────────────────┤─────────────────┤
      │     │           │                                │                 │
      │Uni- │routeCLIMsg│ Daemon (2wk):                  │ Extract lib     │
      │fied │decompose  │  Child-process (~50% reuse)    │ from relay code │
      │Msg  │CLILaunch→ │  Lock+State+HTTP API           │ (1-2wk)         │
      │     │SdkUrlLnch │  Signal handling               │                 │
      │Back │           │                                │ ACP adapter     │
      │end  │SessionStat│ Relay (1.5-2wk):               │  JSON-RPC/stdio │
      │Adpt │generalize │  cloudflared sidecar           │  PTY sidecar    │
      │     │           │  Reverse proxy model           │  (by diff dev!) │
      │Comp │Event map  │  Session routing (as-is)       │  (2-3wk)        │
      │osed │generalize │                                │                 │
      │Intfc│           │ E2E Crypto (2-2.5wk):          │ Codex adapter   │
      │     │           │  libsodium sealed boxes        │  JSON-RPC/WS    │
      │Orig │           │  Pairing link (not QR)         │  Thread/Turn/   │
      │+Tok │           │  EncryptedEnvelope format      │  Item model     │
      │     │           │  Permission signing + replay   │  (3-5 days)     │
      │     │           │  Session revocation            │                 │
      │     │           │  Rate limiting                 │ Contract tests  │
      │     │           │                                │ (1wk rework     │
      │     │           │ Reconnection (1-1.5wk):        │  buffer)        │
      │     │           │  Stable consumer IDs           │                 │
      │     │           │  SequencedMessage<T>           │                 │
      │     │           │  Replay from last_seen_seq     │                 │
      │     │           │  Per-consumer backpressure     │                 │
      │     │           │                                │                 │
      │     │           │ Web Consumer (1-1.5wk):        │                 │
      │     │           │  500-1000 LOC HTML/JS          │                 │
      │     │           │  E2E decrypt + render          │                 │
      │     │           │  Permission handling           │                 │
      │     │           │                                │                 │
      │     │           │ ┌── Phase 2.5 (overlap) ──┐    │                 │
      │     │           │ │ ACP Research (3-5 days) │    │                 │
      │     │           │ │ Read spec, prototype    │    │                 │
      │     │           │ │ JSON-RPC, test vs Goose │    │                 │
      │     │           │ └─────────────────────────┘    │                 │
      ├─────┴───────────┴────────────────────────────────┴─────────────────┤
      │  Test Infrastructure (parallel throughout)                         │
      │  Contract tests → Integration → Relay E2E → ACP + Codex validation │
      └────────────────────────────────────────────────────────────────────┘

      ABORT TRIGGERS:
      #1: Phase 1 > 3 weeks → abstraction is wrong
      #2: Permission coordination > 500 LOC → too complex
      #3: Adapter needs PTY for basic msg (send/receive/result) → agent not ready
      #4: UnifiedMessage changes > 2x during Phase 3 → type too specific
      #5: Crypto overhead > 5ms/msg → implementation wrong
      #6: Same-region RTT > 200ms → architecture wrong
      #7: Cross-region RTT > 500ms → investigate
```

---

## Parallel Tracks Option (2 Engineers)

```
Week  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      ├──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤
      │     │                                  │
      │Ph 0 │    PARALLEL EXECUTION            │
      │BOTH │                                  │
      │     │                                  │
      ├─────┤                                  │
      │     │                                  │
      │     │  TRACK 1 (Adapter Engineer)      │
      │     ├──────────────────────────────────┤
      │     │ SdkUrl Extract   │ ACP Adapter   │ Integration
      │     │ (3-4 wk)         │ (2-3 wk)      │ Support
      │     │ Decompose Bridge │ JSON-RPC      │ (1-2 wk)
      │     │ BackendAdapter   │ stdio         │
      │     │ Contract tests   │ VALIDATES     │
      │     │                  │ interfaces    │
      │     │                  │               │
      │     │  TRACK 2 (Relay Engineer)        │
      │     ├──────────────────────────────────┤
      │     │ Daemon + Tunnel    │ E2E + Recon │ Integration
      │     │ (4-5 wk)           │ (3-4 wk)    │ + Consumer
      │     │ Child-process      │ libsodium   │ (1-2 wk)
      │     │ cloudflared        │ Pairing link│
      │     │ HTTP API           │ Reconnection│
      │     │                    │ Backpressure│
      │     │                    │             │
      │     │              CONVERGENCE ▼       │
      │     │         Week 10: Relay wires     │
      │     │         to BackendAdapter        │
      │     │         (validated by 2          │
      │     │          protocols already)      │
      ├─────┴──────────────────────────────────┤
      │                                        │
      │  Week  6: v0.1.0 — SdkUrl adapter lib  │◄── FIRST OUTPUT
      │  Week 10: v0.2.0-alpha — relay works   │
      │  Week 12: v0.2.0-beta — ACP validated  │
      │  Week 14: v0.2.0 — full relay MVP      │◄── SHIPS
      └────────────────────────────────────────┘

      Advantages:                  Disadvantages:
      • Abstractions from 2        • Requires 2 engineers
        protocols (not 1)          • Integration risk at
      • First output at wk 6        convergence (wk 10)
      • Risk distributed           • Communication overhead
      • ACP validated by wk 9       (weekly sync needed)
```

---

## Security Architecture Detail

```
┌──────────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                              │
│                                                                  │
│  LAYER 1: Transport (Phase 0)                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • WebSocket origin validation (reject untrusted origins)   │  │
│  │ • CLI auth tokens (?token=SECRET per session)              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 2: E2E Encryption (Phase 2)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • libsodium sealed boxes (XSalsa20-Poly1305)               │  │
│  │ • sodium_malloc for key material (mlock'd, not swappable)  │  │
│  │ • Per-message ephemeral keys (limited forward secrecy)     │  │
│  │ • Relay MUST NOT persist encrypted blobs (stateless only)  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 3: Authentication (Phase 2)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Permission signing: HMAC-SHA256(secret,                  │  │
│  │     request_id + behavior + timestamp + nonce)             │  │
│  │ • Anti-replay: nonce set (last 1000), 30s timestamp window │  │
│  │ • One-response-per-request (pendingPermissions.delete)     │  │
│  │ • Secret established locally (daemon→CLI, never over relay)│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 4: Device Management (Phase 2)                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session revocation: revoke-device → new keypair → re-pair│  │
│  │ • Per-consumer rate limiting: 10 msg/s, 100 KB/s           │  │
│  │ • Pairing link expires in 60 seconds                       │  │
│  │ • Single device per pairing cycle                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  DEFERRED (post-MVP):                                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session file encryption at rest (XChaCha20 + OS keychain)│  │
│  │ • QR code scanning (upgrade from pairing link)             │  │
│  │ • Message size padding (privacy vs metadata leaks)         │  │
│  │ • Mutual TLS, expanded RBAC, audit logging                 │  │
│  │ • Forward secrecy beyond sealed box ephemeral keys         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  KNOWN METADATA LEAKS (documented, acceptable for MVP):          │
│  • Session ID (required for routing, random UUID)                │
│  • Message timing (reveals activity patterns)                    │
│  • Message size (large = code output, small = user input)        │
│  • Connection duration, IP addresses, message count              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Package Structure (v2.1)

```
beamcode/                     ◄── Single npm package
├── src/
│   ├── core/                           ◄── SessionBridge, BackendAdapter
│   │   ├── types/                      ◄── UnifiedMessage, Capabilities
│   │   │   └── unified-message.ts      ◄── Designed for streaming AND request/response
│   │   └── interfaces/                 ◄── Authenticator, Transport, Storage
│   │       ├── backend-adapter.ts      ◄── Core: connect, capabilities
│   │       ├── backend-session.ts      ◄── Core: send, messages, close
│   │       ├── reconnectable.ts        ◄── Extension: onDisconnect, replay (relay)
│   │       └── encryptable.ts          ◄── Extension: encrypt, decrypt (relay)
│   ├── adapters/
│   │   ├── sdk-url/                    ◄── Phase 1: extract from monolith
│   │   ├── acp/                        ◄── Phase 3: validate abstractions
│   │   ├── codex/                      ◄── Phase 3: validate (JSON-RPC/WS)
│   │   └── agent-sdk/                  ◄── Phase 4: stretch goal
│   ├── daemon/                         ◄── Phase 2: ~50% reusable from current code
│   │   ├── child-process-supervisor    ◄── manage CLI children via ProcessManager
│   │   ├── lock                        ◄── O_EXCL lock file (NEW)
│   │   ├── state                       ◄── daemon.state.json (NEW)
│   │   └── control-api                 ◄── HTTP on 127.0.0.1:0 (NEW)
│   ├── relay/                          ◄── Phase 2: tunnel integration
│   │   ├── TunnelRelayAdapter          ◄── cloudflared sidecar management
│   │   ├── reconnection                ◄── seq tracking, replay, pagination
│   │   └── encrypted-envelope          ◄── { v, sid, ct, len } wire format
│   ├── consumer/                       ◄── Phase 2: minimal web client (NEW)
│   │   └── index.html                  ◄── 500-1000 LOC, E2E decrypt + render
│   ├── utils/
│   │   ├── pty-bridge/                 ◄── 80% exists (composable utility)
│   │   ├── ndjson/                     ◄── EXISTS
│   │   ├── rate-limiter/               ◄── EXISTS
│   │   └── crypto/                     ◄── NEW: sealed boxes, HMAC, pairing
│   │       ├── sealed-box.ts           ◄── sodium_malloc, encrypt/decrypt
│   │       ├── hmac-signing.ts         ◄── HMAC-SHA256 + nonce + timestamp
│   │       ├── pairing.ts             ◄── Pairing link generation/consumption
│   │       └── key-storage.ts         ◄── OS keychain (keytar) + fallback
│   └── server/                         ◄── WsServer + consumer mgmt
│       ├── consumer-channel.ts         ◄── Per-consumer queue + backpressure
│       └── rate-limiter.ts            ◄── 10 msg/s, 100 KB/s per consumer
│
│  Future split:
│  @beamcode/core
│  @beamcode/adapter-*
│  @beamcode/daemon
│  @beamcode/relay
│  @beamcode/client
│  @beamcode/react
```

---

## What Ships at ~19 Weeks (1 Engineer)

```
  ┌────────────────────────────────────────────────────┐
  │                    DELIVERED                       │
  │                                                    │
  │  ✅ Mobile browser → CF Tunnel → Daemon → Claude   │
  │  ✅ Minimal web consumer (E2E decrypt + render)    │
  │  ✅ E2E encryption with pairing link               │
  │  ✅ Reconnection with message replay               │
  │  ✅ Session revocation (revoke-device)             │
  │  ✅ BackendAdapter with SdkUrl + ACP + Codex       │
  │  ✅ Backpressure (per-consumer send queues)        │
  │  ✅ Per-consumer rate limiting                     │
  │  ✅ npm package v0.2.0                             │
  │                                                    │
  ├────────────────────────────────────────────────────┤
  │                    STRETCH                         │
  │                                                    │
  │  ⏳ AgentSdk adapter (50% success probability)     │
  │                                                    │
  ├────────────────────────────────────────────────────┤
  │                    DEFERRED                        │
  │                                                    │
  │  📋 QR code scanning (upgrade from pairing link)   │
  │  📋 Process persistence across daemon restarts     │
  │  📋 Session file encryption at rest                │
  │  📋 Push notifications (APNS/FCM)                  │
  │  📋 Streaming throttle modes                       │
  │  📋 Multi-device sync                              │
  │  📋 Custom relay server (upgrade from tunnel)      │
  │  📋 Mobile native app                              │
  │  📋 Agent teams coordination                       │
  │  📋 Message size padding (privacy)                 │
  │  📋 Mutual TLS / expanded RBAC / audit logging     │
  │                                                    │
  └────────────────────────────────────────────────────┘
```

---

## Risk Heat Map

```
                          LOW IMPACT ──────────────────── HIGH IMPACT
                    ┌─────────────┬─────────────┬─────────────┐
                    │             │             │             │
   HIGH             │             │ CF Tunnel   │ Phase 2     │
   PROBABILITY      │             │ free tier   │ scope       │
   (>40%)           │             │ changes     │ explosion   │
                    │             │             │             │
                    ├─────────────┼─────────────┼─────────────┤
                    │             │             │             │
   MEDIUM           │ PTY feature │ Extraction  │ Codex WS    │
   PROBABILITY      │ parity gap  │ gamble      │ mode stays  │
   (20-40%)         │ (local vs   │ (relay-     │ experimental│
                    │  remote)    │  biased     │ (fallback:  │
                    │             │  interfaces)│  stdio)     │
                    ├─────────────┼─────────────┼─────────────┤
                    │             │             │             │
   LOW              │             │ ACP window  │ E2E crypto  │
   PROBABILITY      │             │ closes      │ bug (key    │
   (<20%)           │             │ (competitor │ management  │
                    │             │  ships      │ flaw)       │
                    │             │  ACP+relay) │             │
                    └─────────────┴─────────────┴─────────────┘

   TOP 3 RISKS:
   1. Phase 2 scope explosion (HIGH prob, HIGH impact)
      Mitigation: hard timebox 7wk, cut E2E to transport-only if needed
   2. Extraction gamble (MED prob, MED-HIGH impact)
      Mitigation: ACP + Codex adapters validate universality; < 500 LOC signal
   3. Codex WS mode experimental (MED prob, MED impact)
      Mitigation: stdio JSONL fallback; adapter supports both transports
```
