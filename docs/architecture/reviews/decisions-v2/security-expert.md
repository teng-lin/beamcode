# Security Expert Review — Decisions v2 (Relay-First MVP)

**Date**: 2026-02-15
**Reviewer**: Senior Security Architect
**Document Reviewed**: `docs/architecture/decisions.md` (v2 — Relay-First MVP)
**Previous Review**: `docs/architecture/reviews/security-expert.md` (v1)

---

## Executive Summary

The v2 decisions represent a **significant security improvement** over v1. The most critical change — moving E2E encryption from "deferred" to Phase 2 (blocking) — directly addresses the #1 recommendation from my v1 report. The relay-first approach actually *improves* the security story because it forces E2E encryption to be built concurrently with the relay, rather than bolted on after deployment.

**Overall Assessment**: **CONDITIONAL APPROVE** — The security architecture is directionally correct but has 3 gaps that need resolution before Phase 2 implementation begins.

**Key Finding**: The v2 decisions adopted 3 of my 4 P0 recommendations from v1 (E2E encryption, permission signing, encrypted storage). WebSocket origin validation is correctly placed in Phase 0. This is the right priority ordering.

---

## 1. E2E Encryption Plan Validation

### Choice: libsodium sealed boxes (XSalsa20-Poly1305)

**Verdict: CORRECT choice, with one caveat.**

**Why sealed boxes are right for this use case:**

- **Sealed boxes** provide anonymous sender encryption — the mobile client can encrypt without the daemon knowing who sent it (only the daemon's public key is needed to encrypt). This is ideal for the QR code pairing model where the mobile client learns the daemon's public key once.
- **XSalsa20-Poly1305** provides authenticated encryption (AEAD) — tampered ciphertext is rejected. This prevents the relay from modifying encrypted blobs.
- **libsodium** (`sodium-native` for Node.js, `libsodium.js` for browsers) is well-audited, battle-tested, and has excellent cross-platform support.
- **No key management complexity** — sealed boxes use ephemeral sender keys internally, so each message has unique keying material without requiring a ratchet protocol.

**Alternatives considered:**

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| libsodium sealed boxes | Simple, audited, cross-platform | No forward secrecy per-session (only per-message via ephemeral keys) | **Selected** |
| Signal Double Ratchet | Perfect forward secrecy, well-studied | Massive complexity for a single-user MVP; requires state management | Overkill for MVP |
| TLS 1.3 mutual auth | Industry standard, hardware acceleration | Requires certificate infrastructure; relay can't be zero-knowledge with TLS termination | Wrong trust model |
| TweetNaCl + AES-256-GCM | Simple, small | AES-GCM nonce reuse is catastrophic; TweetNaCl not as well maintained | Fragile |
| Age encryption | File-oriented, simple | Not designed for streaming message encryption | Wrong use case |

**The caveat — forward secrecy:**

Sealed boxes provide per-message ephemeral keys (the *sender* generates a new keypair per seal), so compromising the daemon's long-term private key allows decryption of *future* intercepted messages but not *past* ones — this is acceptable for MVP. However, if the relay stores ciphertext, compromising the daemon key retroactively decrypts the stored blobs. **Mitigation**: The relay MUST NOT persist encrypted message blobs. Relay should be stateless pass-through only.

**Timeline estimate: 1-2 weeks is REALISTIC** for the encryption layer alone, given:

- `sodium-native` (Node.js) and `libsodium.js` (browser) are mature packages
- Sealed box API is ~10 lines of code for encrypt/decrypt
- The complexity is in the integration (message framing, error handling, key storage), not the crypto
- Estimate: 3 days crypto primitives, 3-4 days integration, 2-3 days testing

### Implementation Recommendations

```typescript
// Core crypto operations — this is how simple it should be
import sodium from 'sodium-native';

// Daemon generates keypair once during QR pairing
const keypair = {
  publicKey: sodium.sodium_malloc(sodium.crypto_box_PUBLICKEYBYTES),
  secretKey: sodium.sodium_malloc(sodium.crypto_box_SECRETKEYBYTES),
};
sodium.crypto_box_keypair(keypair.publicKey, keypair.secretKey);

// Mobile encrypts (only needs daemon's public key)
function sealMessage(plaintext: Buffer, recipientPubKey: Buffer): Buffer {
  const ciphertext = sodium.sodium_malloc(plaintext.length + sodium.crypto_box_SEALBYTES);
  sodium.crypto_box_seal(ciphertext, plaintext, recipientPubKey);
  return ciphertext;
}

// Daemon decrypts (needs own keypair)
function openMessage(ciphertext: Buffer, keypair: KeyPair): Buffer {
  const plaintext = sodium.sodium_malloc(ciphertext.length - sodium.crypto_box_SEALBYTES);
  if (!sodium.crypto_box_seal_open(plaintext, ciphertext, keypair.publicKey, keypair.secretKey)) {
    throw new Error('Decryption failed — message tampered or wrong key');
  }
  return plaintext;
}
```

**CRITICAL**: Use `sodium.sodium_malloc()` for key material — it allocates memory that is mlock'd (not swapped to disk) and sodium_mprotect'd. Regular `Buffer.alloc()` for keys is a security flaw.

---

## 2. QR Code Pairing Security

### How Key Exchange Works

The QR code pairing flow (Tailscale model) should work as follows:

```
┌─────────────────────────────────────────────────────────────────┐
│ PAIRING FLOW                                                    │
│                                                                 │
│  1. Daemon generates X25519 keypair on first run                │
│  2. Daemon displays QR code containing:                         │
│     {                                                           │
│       "pk": "<base64url daemon public key>",                    │
│       "url": "https://<tunnel-hostname>.cfargotunnel.com",      │
│       "v": 1,                                                   │
│       "fp": "<first 8 chars of SHA256(pk)>"  // visual verify   │
│     }                                                           │
│  3. Mobile scans QR code                                        │
│  4. Mobile generates its own X25519 keypair                     │
│  5. Mobile sends its public key to daemon (encrypted with       │
│     daemon's public key via sealed box)                         │
│  6. Daemon stores mobile's public key                           │
│  7. Both sides now have each other's public keys                │
│  8. All subsequent messages use crypto_box (authenticated E2E)  │
│                                                                 │
│  After step 5, sealed boxes can be upgraded to crypto_box       │
│  (bidirectional authenticated encryption with both keys)        │
└─────────────────────────────────────────────────────────────────┘
```

### Attack Vectors

| Attack | Risk | Mitigation |
|--------|------|------------|
| **QR code shoulder-surfing** | MEDIUM — attacker photographs QR from screen | QR displayed only during pairing; time-limited (60 seconds); require explicit "start pairing" action |
| **QR code screenshotting via malware** | LOW — requires OS-level compromise | If OS is compromised, all bets are off (attacker has file system access anyway) |
| **Replay of pairing QR** | LOW — QR contains static public key | One-time pairing: daemon accepts only one mobile device per pairing cycle. Re-pairing requires explicit daemon action |
| **MITM during initial key exchange (step 5)** | VERY LOW — step 5 is encrypted with daemon's public key from QR | Attacker would need to substitute the QR code itself (requires physical presence or screen compromise) |
| **Stolen daemon private key** | MEDIUM — enables decryption of all future messages | Key stored in OS keychain (see Section 5). Consider key rotation on re-pairing |
| **Rogue tunnel endpoint** | LOW — Cloudflare Tunnel authenticates via cloudflared token | Tunnel hostname is cryptographically bound to the cloudflared instance |

### Is This Tailscale-Comparable?

**Partially.** Tailscale's security model is stronger because:

1. Tailscale uses **WireGuard** (Noise protocol framework with Curve25519, ChaCha20-Poly1305, BLAKE2s) — cryptographically superior to sealed boxes for continuous streaming
2. Tailscale has a **coordination server** for key distribution — we're using QR codes (simpler, but no remote re-keying)
3. Tailscale does **key rotation** automatically — we don't (acceptable for MVP)

**For a single-user MVP, the QR code pairing model is sufficient.** The threat model is much simpler than Tailscale's (single device, single user, no mesh). Upgrade to WireGuard-level crypto is a post-MVP enhancement.

---

## 3. Zero-Knowledge Architecture

### Can the Tunnel Truly Not Read Message Contents?

**Yes, with correct implementation.** The architecture must use a **double-layer model**:

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER MODEL                                                     │
│                                                                 │
│  Outer Layer (Tunnel sees):                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ { "session_id": "abc-123", "payload": "<encrypted>" }   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Inner Layer (Only endpoints see):                              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ { "type": "assistant", "content": "Here's the code..." }│    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Relay routes by session_id (plaintext envelope)                │
│  Relay cannot read payload (encrypted blob)                     │
└─────────────────────────────────────────────────────────────────┘
```

**The v1 review identified a contradiction** (Section 3.3): "If E2E encrypted, how does relay route?" The double-layer model resolves this: session_id is in the plaintext envelope, message content is in the encrypted payload.

### Metadata Leaks

Even with perfect E2E encryption, the relay can observe:

| Metadata | Leaked? | Severity | Mitigation |
|----------|---------|----------|------------|
| **Session ID** | YES — required for routing | LOW — random UUID, no semantic meaning | Rotate session IDs periodically (post-MVP) |
| **Message timing** | YES — relay sees when messages are sent | MEDIUM — reveals activity patterns | Padding messages to fixed intervals (post-MVP, adds latency) |
| **Message size** | YES — encrypted blob has deterministic size | MEDIUM — large messages = code output, small = user input | Pad messages to fixed size buckets (e.g., 1KB, 4KB, 16KB, 64KB) |
| **Connection duration** | YES — relay knows session lifetime | LOW — normal operational metadata | Acceptable |
| **IP addresses** | YES — relay sees both endpoints | MEDIUM — identifies user location | Tor/VPN for privacy-sensitive users (out of scope) |
| **Number of messages** | YES — relay counts encrypted blobs | LOW — reveals interaction density | Acceptable |

**Recommendation**: For MVP, metadata leaks are acceptable. Document them. For post-MVP, add **message size padding** (pad to nearest power-of-2 kilobyte) — this is the highest-value low-effort mitigation.

---

## 4. Permission Response Signing

### Is HMAC-SHA256 Sufficient?

**Yes, for this threat model.** HMAC-SHA256 with a session-bound secret provides:

- **Authentication**: Only the party with the shared secret can produce valid signatures
- **Integrity**: Tampered messages produce invalid MACs
- **128-bit security**: No known practical attacks against HMAC-SHA256

### Replay Attack Mitigation

The decisions document mentions HMAC-SHA256 but does NOT mention replay protection. **This is a gap.**

**Required additions to the signing scheme:**

```typescript
interface SignedPermissionResponse {
  request_id: string;        // Links to specific pending request
  behavior: "allow" | "deny";
  updated_input?: Record<string, unknown>;
  timestamp: number;         // Unix milliseconds — reject if > 30 seconds old
  nonce: string;             // Random 16 bytes hex — reject if seen before
  hmac: string;              // HMAC-SHA256(secret, request_id + behavior + timestamp + nonce)
}
```

**Anti-replay requirements:**
1. **Nonce tracking**: Keep a set of seen nonces (bounded, e.g., last 1000). Reject duplicates.
2. **Timestamp window**: Reject responses older than 30 seconds. This bounds the nonce set size.
3. **Request ID binding**: The HMAC includes `request_id`, preventing cross-request replay.
4. **One-response-per-request**: After accepting a response for a `request_id`, delete from `pendingPermissions` (already implemented at `session-bridge.ts:671`). This is the strongest replay defense — each request can only be answered once.

**Current state is actually PARTIALLY protected** — the `pendingPermissions.delete(requestId)` at line 671 means a replayed response for the same `request_id` is already rejected. The remaining gap is an attacker who replays a response for a *different* pending request with a similar structure. The HMAC with request_id binding closes this.

### Secret Establishment

The shared secret for HMAC should be established during the CLI initialize handshake:

```
Daemon → CLI: initialize request (includes daemon's random 32-byte secret)
CLI → Daemon: initialize response (acknowledges, stores secret)
```

Since CLI and daemon are on the same machine communicating via localhost, the initialize message is not exposed to the network. The secret never traverses the relay.

---

## 5. Encrypted Storage

### Is XChaCha20-Poly1305 the Right Choice?

**Yes.** XChaCha20-Poly1305 is superior to AES-256-GCM for this use case:

| Property | XChaCha20-Poly1305 | AES-256-GCM |
|----------|-------------------|-------------|
| Nonce size | 24 bytes (safe to randomize) | 12 bytes (MUST NOT reuse) |
| Nonce reuse catastrophe | Limited damage | Complete security failure |
| Software performance | Fast without hardware AES | Needs AES-NI for performance |
| Key size | 256-bit | 256-bit |
| AEAD | Yes | Yes |
| libsodium support | Native | Via aead construct |

**The 24-byte nonce is the key advantage** — with random nonces, you can safely encrypt ~2^48 messages before nonce collision becomes probable. AES-256-GCM's 12-byte nonce means collision at ~2^24 messages (16 million) — risky for high-throughput session files that are frequently rewritten.

### OS Keychain Integration — Platform Compatibility

| Platform | Keychain API | Node.js Library | Maturity |
|----------|-------------|-----------------|----------|
| **macOS** | Security.framework (Keychain) | `keytar` or `node-keychain` | Excellent |
| **Linux** | libsecret (GNOME Keyring) / KWallet | `keytar` | Good (requires D-Bus) |
| **Windows** | DPAPI / Credential Manager | `keytar` | Good |
| **Headless Linux** | No keychain available | File-based with restrictive permissions | Fallback needed |

**The `keytar` package** (now maintained as `@aspect-build/keytar` or via `node-keytar`) provides a unified API across platforms. However:

**CRITICAL CONCERN**: `keytar` relies on native compilation (N-API). This adds build complexity for an npm package. **Alternative**: Use `node:crypto.scryptSync()` with a user-provided passphrase as a fallback for environments without keychain access.

**Recommended key derivation chain:**

```
OS Keychain → master key (32 bytes, stored in keychain)
            → per-session key = HKDF-SHA256(master_key, session_id)
            → encrypt session file with XChaCha20-Poly1305(per-session_key, nonce, plaintext)
```

**HKDF** (HMAC-based Key Derivation Function) derives unique keys per session from a single master key. This means:
- Only one secret stored in keychain
- Compromising one session file doesn't compromise others (different keys)
- Key rotation = rotate master key + re-encrypt all sessions

### Headless Fallback

For CI environments, Docker containers, or headless Linux servers:

```typescript
// Fallback: derive key from environment variable
const masterKey = process.env.CLAUDE_BRIDGE_ENCRYPTION_KEY
  ? Buffer.from(process.env.CLAUDE_BRIDGE_ENCRYPTION_KEY, 'hex')
  : null;

// Or: derive from passphrase
const masterKey = crypto.scryptSync(passphrase, salt, 32);
```

**Document the fallback clearly** — users in headless environments need to know encryption is degraded.

---

## 6. Threat Model for Relay MVP

### Top 5 Attack Vectors

#### 1. Compromised Cloudflare Tunnel Token — CRITICAL

**Attack**: If the cloudflared tunnel token is stolen (e.g., from `~/.cloudflared/` or environment variable), an attacker can:
- Spin up a rogue tunnel endpoint with the same hostname
- Intercept all traffic between mobile and daemon
- E2E encryption prevents content reading, but attacker can DoS or perform traffic analysis

**Mitigation**:
- Store tunnel token in OS keychain alongside encryption keys
- Monitor for duplicate tunnel connections (Cloudflare provides this via dashboard)
- E2E encryption ensures confidentiality even if tunnel is compromised (defense in depth)
- Consider tunnel token rotation on re-pairing

**Residual risk**: LOW with E2E encryption (attacker sees only encrypted blobs).

#### 2. Mobile Device Compromise — HIGH

**Attack**: If the mobile device is compromised (malware, stolen phone):
- Attacker has the daemon's public key and the mobile's private key
- Can establish a valid E2E encrypted session
- Can approve/deny permissions, send messages, see code

**Mitigation**:
- Implement session revocation: daemon can "forget" a paired device
- Require re-pairing after inactivity timeout (e.g., 7 days)
- Consider biometric unlock for the mobile client before sending permission responses
- Display active sessions on daemon (so user can spot unauthorized access)

**Residual risk**: HIGH — mobile compromise is game-over for that device. Revocation limits blast radius.

#### 3. Permission Response Spoofing via Relay Injection — HIGH

**Attack**: A sophisticated attacker who compromises the Cloudflare Tunnel could attempt to:
- Inject fabricated encrypted blobs into the session stream
- Without the encryption key, the blobs won't decrypt — attack fails

**But**: If the attacker compromises the mobile device instead, they can produce valid encrypted permission responses. **This is why HMAC signing on permission responses is non-negotiable** — even if the mobile is compromised, the attacker needs the session-bound HMAC secret (which is established locally between daemon and CLI, never traverses the relay).

**Mitigation**: Permission response signing with HMAC-SHA256 (already in Phase 2 plan). The HMAC secret MUST be established locally, never sent through the relay.

#### 4. Daemon Local Privilege Escalation — MEDIUM

**Attack**: A malicious process on the developer's machine:
- Reads the daemon state file to find the control API port
- Connects to `127.0.0.1:<port>` and creates/controls sessions
- Phase 0 CLI auth tokens mitigate this, but the control API itself needs auth

**Mitigation**:
- Phase 0 CLI auth tokens (already planned)
- Control API should use Unix domain sockets (not TCP) with `0700` permissions
- Validate connecting process identity via `SO_PEERCRED` (Linux) or `LOCAL_PEERPID` (macOS)

#### 5. Session History Exfiltration via Cloud Sync — MEDIUM

**Attack**: Session files in `~/.claude-bridge/` may be synced by:
- iCloud Drive (macOS default syncs home directory)
- Dropbox, Google Drive, OneDrive
- Time Machine backups (plaintext)

If session files contain code, API keys, or conversation history, cloud sync exposes them.

**Mitigation**: Encrypted storage (Phase 2) resolves this completely. **But Phase 0-1 sessions are unencrypted.** Recommend:
- Add `~/.claude-bridge` to `.gitignore` template
- Document that users should exclude from cloud sync
- Consider using `~/Library/Application Support/claude-bridge/` on macOS (not synced by iCloud)

---

## 7. Timeline Validation

### Security Work Breakdown

| Item | Decisions Estimate | My Estimate | Notes |
|------|-------------------|-------------|-------|
| E2E encryption (libsodium) | 1-2 weeks | **1.5-2 weeks** | Crypto primitives are simple; integration with message framing and reconnection is the real work |
| QR code pairing | (included above) | **+2-3 days** | QR generation, scanning, key exchange protocol |
| Permission response signing | 3 days | **3-4 days** | HMAC implementation simple; replay protection adds complexity |
| Encrypted storage | 1 week | **1-1.5 weeks** | Keychain integration is platform-specific and fiddly |
| **Total security work** | **~2.5-3.5 weeks** | **~3-4 weeks** | Decisions underestimate by ~0.5-1 week |

### Is the Combined Work Achievable?

Phase 2 budget is **4-5 weeks** total for: Daemon (2 weeks) + Relay (1.5-2 weeks) + E2E (1-2 weeks) + Reconnection.

**Problem**: 2 + 1.5 + 1.5 = 5 weeks minimum, and that excludes reconnection protocol. The security work competes with relay work for the same 4-5 week window.

**Assessment**: Phase 2 is **1-2 weeks over budget** when security work is properly scoped. Two options:

1. **Extend Phase 2 to 6-7 weeks** (recommended — security cannot be compressed)
2. **Parallelize**: One engineer on daemon + relay, another on E2E + encrypted storage. This works because the security layer can be developed against mock messages, then integrated.

**The 200ms latency abort trigger** (decisions line 301) is easily achievable. libsodium sealed box encrypt/decrypt is ~0.1ms on modern hardware. The overhead is dominated by serialization and network, not crypto.

---

## 8. Missing Security Considerations

### 8.1 Session Revocation (NOT ADDRESSED)

The decisions document has no mechanism for:
- Revoking a paired mobile device
- Forcing re-pairing after suspected compromise
- Remote wipe of paired device credentials

**Recommendation**: Add a `revoke-device` command to the daemon control API. On revocation:
1. Generate new keypair
2. Delete old mobile public key
3. Require new QR code scan for re-pairing

### 8.2 Rate Limiting on Relay Messages (NOT ADDRESSED)

An authenticated mobile client could flood the relay with messages, causing:
- Daemon CPU exhaustion (decrypting messages)
- CLI overwhelm (processing rapid inputs)

**Recommendation**: Add per-consumer rate limiting at the daemon level:
- Max 10 messages/second per consumer
- Max 100 KB/second per consumer
- Exponential backoff on limit violations

### 8.3 Encrypted Message Framing (NOT ADDRESSED)

How are encrypted messages framed in the WebSocket stream? The decisions document says "encrypted blobs" but doesn't specify:
- Message boundary detection (length-prefix vs delimiter)
- Maximum message size (prevents memory exhaustion)
- Version field (for future crypto algorithm upgrades)

**Recommendation**: Use a minimal envelope:

```typescript
interface EncryptedEnvelope {
  v: 1;                    // Protocol version
  sid: string;             // Session ID (plaintext, for routing)
  ct: string;              // Base64url ciphertext
  len: number;             // Original plaintext length (for allocation)
}
```

### 8.4 Tunnel Hostname Discovery (NOT ADDRESSED)

How does the mobile client know the tunnel hostname after pairing? Options:

1. **Embedded in QR code** (simplest, but hostname changes on daemon restart if using random tunnel names)
2. **DNS TXT record** (requires DNS setup, complex)
3. **Hardcoded subdomain per user** (requires Cloudflare account, but stable)

**Recommendation**: Embed tunnel URL in QR code. If hostname changes, require re-pairing. For post-MVP, consider a lightweight discovery service.

### 8.5 Browser-Side Key Storage (NOT ADDRESSED)

The mobile client (browser) needs to store:
- Its own keypair
- The daemon's public key
- The HMAC secret for permission signing (wait — this shouldn't be on mobile, see note)

**Note on HMAC secret**: The HMAC secret for permission response signing should be between daemon and CLI *only* (both on the same machine). The mobile client signs permission responses with the E2E encryption layer, which provides authentication inherently. The HMAC is a defense-in-depth measure for the localhost CLI ↔ daemon channel.

**Browser key storage options:**
- `IndexedDB` with `CryptoKey` objects (Web Crypto API) — keys are non-extractable
- `localStorage` — keys are extractable (less secure, but simpler)

**Recommendation**: Use Web Crypto API with `extractable: false` for the mobile keypair. This prevents JavaScript code (including XSS) from reading the raw key material.

### 8.6 Cloudflare Tunnel Dependency Risk (NOT ADDRESSED)

Cloudflare could:
- Deprecate the Tunnel free tier
- Change the API
- Experience outages
- Require account verification that blocks CI usage

**Recommendation**: Design the tunnel integration as a pluggable adapter (the decisions doc already uses `TunnelRelayAdapter`). Ensure the interface supports alternative implementations (e.g., ngrok, bore, rathole) as drop-in replacements.

---

## 9. Comparison: v1 vs v2 Security Posture

| Security Concern | v1 Decision | v2 Decision | Improvement |
|-----------------|------------|------------|-------------|
| E2E encryption | Deferred | Phase 2 (blocking) | **MAJOR** |
| Permission signing | Not mentioned | Phase 2 (3 days) | **MAJOR** |
| Encrypted storage | Deferred | Phase 2 (1 week) | **MAJOR** |
| WebSocket origin validation | Phase 0 | Phase 0 (unchanged) | Same |
| CLI auth tokens | Phase 0 | Phase 0 (unchanged) | Same |
| Session revocation | Not addressed | Not addressed | **GAP** |
| Rate limiting | Not addressed | Not addressed | **GAP** |
| Message framing spec | Not addressed | Not addressed | **GAP** |
| RBAC expansion | Deferred | Deferred | Same |
| Mutual TLS | Deferred | Deferred | Same |
| Audit logging | Deferred | Deferred | Same |

**v2 resolves 3 of 4 CRITICAL items from v1.** The remaining gaps (revocation, rate limiting, message framing) are MEDIUM severity and acceptable for MVP if documented.

---

## 10. Final Recommendations

### Must-Fix Before Phase 2 Implementation (3 items)

1. **Specify replay protection for permission signing** — Add nonce + timestamp window to the HMAC scheme. Without this, HMAC-SHA256 alone is insufficient. (Effort: 0.5 days of design)

2. **Define encrypted message envelope format** — The relay needs to know how to route without decrypting. Specify the plaintext envelope + encrypted payload format now, not during implementation. (Effort: 0.5 days of design)

3. **Add session revocation mechanism** — Even minimal ("daemon forgets device, requires re-pairing") is essential. A compromised mobile device with no revocation is an open-ended security incident. (Effort: 1 day of design, 2-3 days implementation)

### Should-Fix During Phase 2

4. **Add per-consumer rate limiting at daemon level** (2 days)
5. **Use secure browser key storage** (Web Crypto API, non-extractable keys) (1 day)
6. **Document metadata leaks** in the security model (0.5 days)
7. **Extend Phase 2 timeline by 1-2 weeks** to properly scope security work

### Accept for MVP (document as known limitations)

8. No forward secrecy beyond sealed box ephemeral keys
9. No message size padding (metadata leakage)
10. No tunnel hostname stability (re-pairing on restart)
11. Binary RBAC (participant/observer only)
12. No audit logging

---

## Conclusion

The v2 relay-first architecture with E2E encryption as a blocking requirement is **security-sound for an MVP**. The libsodium + QR code pairing approach is the right level of complexity — strong enough to protect against realistic threats, simple enough to implement in the allocated timeline.

The three must-fix items (replay protection, message envelope, session revocation) are design-level gaps, not architectural flaws. They can be resolved in < 2 days of design work before Phase 2 begins.

**Bottom line**: The v1 decisions had relay as an unfunded security mandate. The v2 decisions fund it properly. This is the correct approach.

---

**Report Prepared By**: Senior Security Architect
**Date**: 2026-02-15
**Next Review**: After E2E encryption implementation is complete (Phase 2 midpoint)
