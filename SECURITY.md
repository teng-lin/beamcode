# Security Policy

This document describes the security architecture of **beamcode**, a universal adapter library that bridges coding agent CLIs (Claude Code, Codex, etc.) to frontend consumers (web, mobile) with optional remote access via end-to-end encrypted relay through Cloudflare Tunnel.

---

## 1. Security Architecture Overview

beamcode enforces defense-in-depth through four distinct security layers:

### Layer 1: Transport

- **WebSocket origin validation** (`OriginValidator`): Connections are checked against an allowlist. Localhost origins (`localhost`, `127.0.0.1`, `[::1]`) are always permitted. Remote origins must be explicitly allowlisted. Empty-string origins are rejected.
- **Per-session auth tokens**: Each CLI session receives a cryptographically random 256-bit token (generated via `crypto.randomBytes(32)`). Consumers authenticate by passing `?token=SECRET` as a query parameter on the WebSocket upgrade request. Tokens are validated using `crypto.timingSafeEqual` to prevent timing side-channel attacks.
- **Token lifecycle**: Tokens are stored in `InMemoryTokenRegistry` and can be revoked per session.

### Layer 2: End-to-End Encryption

- **Primitive**: X25519 key agreement + XSalsa20-Poly1305 authenticated encryption via libsodium (`crypto_box`).
- **Initial key exchange**: Libsodium sealed boxes (`crypto_box_seal` / `crypto_box_seal_open`) -- anonymous sender encryption using X25519 + XSalsa20-Poly1305 with an ephemeral sender keypair.
- **Post-pairing messages**: `crypto_box_easy` / `crypto_box_open_easy` -- authenticated public-key encryption where both parties prove identity via their long-term X25519 keypair.
- **Key destruction**: `destroyKey()` zero-fills secret key material in memory.
- **Per-message nonces**: Each encrypted message uses a fresh random nonce (`crypto_box_NONCEBYTES` = 24 bytes) generated via `sodium.randombytes_buf`.
- **Relay-blind**: The Cloudflare Tunnel relay and any intermediary infrastructure cannot decrypt message contents. Only `EncryptedEnvelope.sid` (session ID, for routing) is visible in plaintext.
- **Bridge visibility**: The local bridge process CAN see plaintext, as it must translate between CLI wire format and consumer wire format.

### Layer 3: Authentication (Permission Signing)

- **Primitive**: HMAC-SHA-512/256 via libsodium `crypto_auth` / `crypto_auth_verify`.
- **Signed input**: `HMAC(secret, requestId + behavior + canonicalize(updatedInput) + timestamp + nonce)`.
- **Anti-replay**: `NonceTracker` maintains a sliding window of the last 1,000 nonces. Duplicate nonces are rejected. Timestamps outside a 30-second window are rejected.
- **One-response-per-request**: Each permission request ID can only be answered once.
- **Secret establishment**: The HMAC secret is established locally between the daemon and CLI process, never transmitted over the relay.

### Layer 4: Device Management

- **Session revocation**: `PairingManager.revoke()` destroys the current keypair and generates a fresh X25519 keypair, forcing the consumer to re-pair.
- **Per-consumer rate limiting**: `TokenBucketLimiter` enforces configurable tokens-per-second and burst size per connected consumer.
- **Pairing link expiry**: Links expire after 60 seconds (server-side enforcement via `PAIRING_TTL_MS`).
- **Single device per pairing cycle**: Once a pairing link is consumed (`paired = true`), subsequent pairing attempts on the same link are rejected. A `pairingInProgress` guard prevents concurrent pairing race conditions.

---

## 2. End-to-End Encryption Details

### Implementation

All cryptographic operations are implemented in `src/utils/crypto/` using `libsodium-wrappers-sumo` version 0.7.15 (WASM build, no native C toolchain required).

### Key Generation

```
generateKeypair() -> { publicKey: Uint8Array, secretKey: Uint8Array }
```

Generates an X25519 keypair via `sodium.crypto_box_keypair()`. Public keys are 32 bytes. Secret keys are 32 bytes.

### Key Storage and Destruction

- `destroyKey(secretKey)` zero-fills the `Uint8Array` backing the secret key via `secretKey.fill(0)`.
- The `PairingManager` calls `destroyKey()` on the previous secret key before generating a new keypair (during both new pairing link generation and revocation).

### Sealed Boxes (Pairing Only)

Used exclusively during the pairing handshake for anonymous sender encryption:

- `seal(message, recipientPublicKey)` -- encrypts using `crypto_box_seal`. The sender remains anonymous; an ephemeral keypair is generated internally by libsodium.
- `sealOpen(ciphertext, publicKey, secretKey)` -- decrypts using `crypto_box_seal_open`. Only the holder of the recipient's secret key can open the sealed box.

### Authenticated Encryption (Post-Pairing)

All messages after pairing use `crypto_box`:

- `encrypt(message, nonce, theirPublicKey, mySecretKey)` -- `crypto_box_easy` (X25519 Diffie-Hellman + XSalsa20-Poly1305).
- `decrypt(ciphertext, nonce, theirPublicKey, mySecretKey)` -- `crypto_box_open_easy`. Throws on authentication failure (tampered ciphertext, wrong key).
- `generateNonce()` -- generates `crypto_box_NONCEBYTES` (24) random bytes via `sodium.randombytes_buf`.

### Wire Format

The `EncryptedEnvelope` is the over-the-wire representation:

```json
{
  "v": 1,
  "sid": "<session-id>",
  "ct": "<base64url-no-padding(nonce || ciphertext)>"
}
```

- `v` -- protocol version (currently `1`).
- `sid` -- session ID in plaintext, used for routing at the relay layer. This is a random UUID and is not sensitive.
- `ct` -- base64url-encoded (no padding) concatenation of the 24-byte nonce and the `crypto_box_easy` ciphertext. The receiver splits at `crypto_box_NONCEBYTES` to recover the nonce and ciphertext.

### EncryptionLayer Middleware

The `EncryptionLayer` class (`src/relay/encryption-layer.ts`) transparently encrypts and decrypts messages between the `SessionBridge` and the WebSocket transport:

- **Outbound**: `ConsumerMessage` -> JSON serialize -> UTF-8 encode -> `wrapEnvelope()` -> `EncryptedEnvelope` JSON string.
- **Inbound**: Raw WebSocket data -> `deserializeEnvelope()` -> `unwrapEnvelope()` -> UTF-8 decode -> JSON parse -> `InboundMessage`.
- **Mixed-mode detection**: `EncryptionLayer.isEncrypted()` detects whether a raw message is an `EncryptedEnvelope`, enabling graceful transition during the pairing handshake.
- **Deactivation**: The layer can be deactivated (e.g., on revocation) and reactivated with an updated peer key after re-pairing.

---

## 3. Pairing Flow

The pairing handshake establishes a shared cryptographic context between the daemon and a remote consumer:

1. **Daemon generates X25519 keypair** via `PairingManager.generatePairingLink()`. Any previous secret key is destroyed.
2. **Daemon starts Cloudflare Tunnel** via `cloudflared-manager`, obtaining a public tunnel URL.
3. **Daemon prints pairing link**:
   ```
   https://<tunnel-host>/pair?pk=<base64url(daemon_public_key)>&fp=<fingerprint>&v=1
   ```
   - `pk`: The daemon's 32-byte X25519 public key, base64url-encoded (no padding).
   - `fp`: First 8 bytes of the public key as lowercase hex (16 hex characters). Used for visual verification.
   - `v`: Protocol version (`1`).
4. **User opens the link** on a mobile browser or other consumer device.
5. **Consumer extracts the daemon's public key** from the `pk` URL parameter via `parsePairingLink()`. Validates it is exactly 32 bytes.
6. **Consumer generates its own X25519 keypair** locally.
7. **Consumer seals its public key** using the daemon's public key via `sealPublicKeyForPairing()` (libsodium sealed box). Sends the sealed bytes to the daemon.
8. **Daemon unseals the consumer's public key** via `sealOpen()`. Validates it is exactly 32 bytes.
9. **Both sides now hold each other's public keys**. All subsequent messages use `crypto_box` (authenticated, bidirectional end-to-end encryption).

### Pairing Security Properties

- **60-second expiry**: The pairing link expires after `PAIRING_TTL_MS` (60,000 ms). Server-side enforcement rejects late pairing attempts.
- **One-time use**: Once paired (`paired = true`), the link cannot be reused. A `pairingInProgress` mutex prevents concurrent pairing race conditions.
- **Fingerprint verification**: The `fp` parameter allows users to visually verify the daemon's public key fingerprint.
- **Post-MVP**: QR code upgrade planned for easier cross-device pairing.

---

## 4. Permission Signing

Permission responses (allow/deny for tool use, file access, etc.) are signed to prevent unauthorized permission injection.

### Threat Model

Permission signing prevents:

- **Replay attacks**: Nonce + timestamp window rejects replayed permission responses.
- **Request ID tampering**: The `requestId` is bound into the HMAC input, preventing a valid signature from being reattached to a different request.
- **Man-in-the-middle permission injection**: An attacker who can observe (but not decrypt) traffic cannot forge valid permission responses without the shared secret.

### Signature Construction

```
tag = crypto_auth(requestId + behavior + canonicalize(updatedInput) + timestamp + hexNonce, secret)
```

- `crypto_auth` is HMAC-SHA-512/256 (libsodium's keyed authentication primitive).
- `canonicalize()` produces a deterministic JSON representation of the `updatedInput` field.
- The nonce is encoded as lowercase hex before concatenation.

### Replay Protection (`NonceTracker`)

- Maintains a `Map<string, number>` of recently seen nonces (hex-encoded) to their timestamps.
- Maximum capacity: 1,000 entries (configurable).
- Time window: 30 seconds (configurable). Messages with timestamps outside `+/- 30s` of the current time are rejected.
- Eviction: When at capacity, entries older than the time window are pruned. If still full, the oldest entry is removed.

### Secret Establishment

The HMAC shared secret is established locally between the daemon process and the CLI child process. It is never transmitted over the relay or any network channel.

---

## 5. Input Validation and Hardening

### CLI Binary Validation

The `claudeBinary` parameter is validated before spawning a child process (`src/adapters/claude/claude-launcher.ts`):

- **Absolute paths**: Must match `/^\/[a-zA-Z0-9_./-]+$/` (no shell metacharacters, no `..`).
- **Simple basenames**: Must match `/^[a-zA-Z0-9_.-]+$/` (e.g., `claude`, `claude_dev.2`).
- **Rejected patterns**: Relative paths with `../`, shell injection attempts (`;`, backticks, `$()`, spaces, `!`), and any characters outside the allowlisted set.

### Environment Variable Deny List

The `envDenyList` configuration strips dangerous environment variables from the CLI child process environment:

- **Default list**: `["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"]`.
- **Cannot be cleared**: If user configuration sets `envDenyList` to an empty array, `resolveConfig()` restores the default list. This prevents accidental removal of library injection protections.

### Session ID Validation

Session IDs must be lowercase UUIDs matching:

```
/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
```

This validation is enforced at the `FileStorage` layer (`src/adapters/file-storage.ts`) before any filesystem operations.

### Path Traversal Prevention

`FileStorage` uses a two-layer defense:

1. **UUID validation**: Session IDs are validated against the strict UUID regex before constructing file paths.
2. **`safeJoin()` containment check**: The resolved path must be contained within the storage base directory. The check appends a path separator to the base directory to prevent prefix false-positives (e.g., `/tmp/sessions` vs `/tmp/sessions-evil`).

### Daemon Lock File

The daemon uses `O_CREAT | O_EXCL` (`open(lockPath, 'wx')`) to atomically acquire a lock file, preventing duplicate daemon instances. Stale locks (from crashed processes) are detected by sending signal 0 to the recorded PID.

### Control API

The daemon exposes an HTTP control API (`src/daemon/control-api.ts`) with:

- **Localhost binding**: The server binds to `127.0.0.1:0` (random port, localhost only). It is not accessible from remote hosts.
- **Bearer token authentication**: All endpoints require `Authorization: Bearer <token>`. The token is a 256-bit random value (`crypto.randomBytes(32).toString('hex')`) generated fresh on each daemon start.
- **No persistent credentials**: The token is written to a state file readable only by the local user and regenerated on every daemon restart.

---

## 6. Rate Limiting and Circuit Breaking

### Token Bucket Rate Limiter

`TokenBucketLimiter` (`src/adapters/token-bucket-limiter.ts`) enforces per-consumer message rate limits:

- **Configurable parameters**: `tokensPerSecond` (default: 50) and `burstSize` (default: 20).
- **Refill mechanism**: Tokens are refilled continuously based on elapsed time since last refill, up to the bucket capacity.
- **Rejection**: When the bucket is empty, `tryConsume()` returns `false` and the message is rejected.

### Sliding Window Circuit Breaker

`SlidingWindowBreaker` (`src/adapters/sliding-window-breaker.ts`) prevents CLI restart cascades:

- **Three states**: `CLOSED` (normal), `OPEN` (rejecting), `HALF_OPEN` (testing recovery).
- **Failure threshold**: Default 5 failures trigger transition from CLOSED to OPEN.
- **Recovery time**: Default 30 seconds in OPEN before transitioning to HALF_OPEN.
- **Success threshold**: Default 2 consecutive successes in HALF_OPEN return to CLOSED.
- **Single failure in HALF_OPEN**: Immediately returns to OPEN.

### Per-Consumer Backpressure

- `ConsumerChannel` maintains a send queue with a configurable high-water mark (`pendingMessageQueueMaxSize`, default: 100).
- Messages exceeding the queue limit are dropped to prevent memory exhaustion.

### Idle Session Timeout

- Configurable via `idleSessionTimeoutMs` (default: 0, disabled).
- When enabled, sessions with no activity for the configured duration are automatically cleaned up.

---

## 7. Known Limitations and Metadata Leaks

The following limitations are documented and accepted for the current release:

### Metadata Visible to Relay/Network Observers

- **Session ID**: Visible in the `EncryptedEnvelope.sid` field (random UUID, not sensitive, required for routing).
- **Message timing**: Activity patterns are observable (when messages are sent/received).
- **Message size**: Ciphertext length correlates with plaintext length. Large messages likely indicate code output; small messages likely indicate user input.
- **Connection duration**: How long a session is active.
- **IP addresses**: Both daemon and consumer IP addresses are visible to the Cloudflare Tunnel infrastructure.
- **Message count**: The number of messages exchanged is observable.

### Deferred to Post-MVP

- **No message size padding**: Messages are not padded to a uniform length. Traffic analysis can infer content type from size distribution.
- **No forward secrecy**: Beyond the ephemeral key used in the sealed box during pairing, there is no ratcheting or ephemeral key rotation for post-pairing messages. Compromise of a long-term secret key allows decryption of all past messages encrypted with that key.
- **No mutual TLS**: The relay connection uses standard TLS provided by Cloudflare Tunnel, not mutual TLS with client certificates.
- **No session file encryption at rest**: Session state files are stored as plaintext JSON on disk. They are protected by filesystem permissions only.
- **No audit logging**: Security-relevant events (pairing attempts, permission decisions, revocations) are not written to a structured audit log.
- **Consumer-side encryption not yet integrated**: The new React frontend (`web/`) does not yet implement client-side E2E encryption. Full consumer-side encryption requires integration with the pairing flow in a browser environment.

---

## 8. Reporting Security Issues

If you discover a security vulnerability in beamcode, please report it responsibly:

1. **Do not open a public GitHub issue.** Security vulnerabilities should not be disclosed publicly until a fix is available.
2. **Email the maintainers** with a description of the vulnerability, steps to reproduce, and any relevant proof-of-concept code.
3. **Allow reasonable time** for a fix to be developed and released before public disclosure. We aim to acknowledge reports within 48 hours and provide a fix timeline within 7 days.

When reporting, please include:

- The version of beamcode affected.
- A description of the vulnerability and its potential impact.
- Steps to reproduce or a minimal proof-of-concept.
- Any suggested mitigations or fixes, if applicable.

We appreciate responsible disclosure and will credit reporters (with their permission) in the release notes for the fix.
