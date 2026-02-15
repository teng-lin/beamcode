# API Reference

Complete API reference for claude-code-bridge production hardening features.

## Table of Contents

- [SessionManager](#sessionmanager)
- [Interfaces & Types](#interfaces--types)
- [Configuration](#configuration)
- [Operational Commands](#operational-commands)
- [HTTP Endpoints](#http-endpoints)
- [Events](#events)

---

## SessionManager

Main facade for session management. Combines SessionBridge and CLILauncher.

```typescript
import { SessionManager } from "claude-code-bridge";
```

### Constructor

```typescript
const manager = new SessionManager({
  config: ProviderConfig;
  processManager: ProcessManager;
  storage?: SessionStorage & LauncherStateStorage;
  logger?: Logger;
  gitResolver?: GitInfoResolver;
  authenticator?: Authenticator;
  beforeSpawn?: (sessionId: string, spawnOptions: SpawnOptions) => void;
  server?: WebSocketServerLike;
  commandRunner?: CommandRunner;          // optional; enables PTY-based slash commands
});
```

### Methods

#### start()
```typescript
async start(): Promise<void>
```
Initialize the session manager:
1. Wire bridge + launcher events
2. Restore from storage
3. Start reconnection watchdog
4. Start idle timeout watcher
5. Start connection heartbeat
6. Start WebSocket server

**Example:**
```typescript
await manager.start();
console.log("Session manager started");
```

#### stop()
```typescript
async stop(): Promise<void>
```
Graceful shutdown:
1. Drain consumers (send shutdown message, wait for disconnect)
2. Kill all CLI processes
3. Persist session state
4. Close all sockets
5. Clear timers

**Example:**
```typescript
await manager.stop();
console.log("Session manager stopped");
```

#### getSessionStats(sessionId)
```typescript
getSessionStats(sessionId: string): SessionStats | undefined
```

Get real-time statistics for a specific session.

**Returns:**
```typescript
interface SessionStats {
  sessionId: string;
  consumers: number;
  messageCount: number;
  uptime: number;        // milliseconds
  lastActivity: number;  // timestamp
  cliConnected: boolean;
  pendingPermissions: number;
  queuedMessages: number;
}
```

**Example:**
```typescript
const stats = manager.getSessionStats("abc-123");
console.log(`Session ${stats.sessionId} has ${stats.consumers} consumers`);
```

#### getAllSessionStats()
```typescript
getAllSessionStats(): SessionStats[]
```

Get statistics for all active sessions.

**Example:**
```typescript
const allStats = manager.getAllSessionStats();
console.log(`${allStats.length} active sessions`);
```

### Events

All events emitted by SessionManager (typed):

```typescript
manager.on("cli:session_id", ({ sessionId, cliSessionId }) => {});
manager.on("cli:connected", ({ sessionId }) => {});
manager.on("cli:disconnected", ({ sessionId }) => {});
manager.on("cli:relaunch_needed", ({ sessionId }) => {});
manager.on("consumer:connected", ({ sessionId, consumer }) => {});
manager.on("consumer:disconnected", ({ sessionId, consumer }) => {});
manager.on("consumer:authenticated", ({ sessionId, consumer }) => {});
manager.on("consumer:auth_failed", ({ sessionId, error }) => {});
manager.on("message:outbound", ({ sessionId, message }) => {});
manager.on("message:inbound", ({ sessionId, message }) => {});
manager.on("permission:requested", ({ sessionId, permissionId }) => {});
manager.on("permission:resolved", ({ sessionId, permissionId }) => {});
manager.on("session:first_turn_completed", ({ sessionId }) => {});
manager.on("session:closed", ({ sessionId }) => {});
manager.on("slash_command:executed", ({ sessionId, command, source, durationMs }) => {});
manager.on("slash_command:failed", ({ sessionId, command, error }) => {});
manager.on("auth_status", ({ sessionId, status }) => {});
manager.on("error", ({ source, error, sessionId }) => {});
manager.on("process:spawned", ({ sessionId, pid }) => {});
manager.on("process:exited", ({ sessionId, pid, code }) => {});
manager.on("process:connected", ({ sessionId }) => {});
manager.on("process:resume_failed", ({ sessionId }) => {});
manager.on("process:stdout", ({ sessionId, data }) => {});
manager.on("process:stderr", ({ sessionId, data }) => {});
```

---

## Interfaces & Types

### ProviderConfig

```typescript
interface ProviderConfig {
  // Required
  port: number;

  // Timeouts (milliseconds)
  gitCommandTimeoutMs?: number;
  relaunchGracePeriodMs?: number;
  killGracePeriodMs?: number;
  storageDebounceMs?: number;
  reconnectGracePeriodMs?: number;
  resumeFailureThresholdMs?: number;
  relaunchDedupMs?: number;
  authTimeoutMs?: number;
  shutdownGracePeriodMs?: number;

  // Resource limits
  maxMessageHistoryLength?: number;
  maxConcurrentSessions?: number;
  idleSessionTimeoutMs?: number;
  pendingMessageQueueMaxSize?: number;

  // Rate limiting
  consumerMessageRateLimit?: {
    tokensPerSecond: number;
    burstSize: number;
  };

  // Circuit breaker
  cliRestartCircuitBreaker?: {
    failureThreshold: number;
    windowMs: number;
    recoveryTimeMs: number;
    successThreshold: number;
  };

  // CLI
  defaultClaudeBinary?: string;
  cliWebSocketUrlTemplate?: (sessionId: string) => string;

  // Slash command execution
  slashCommand?: {
    ptyTimeoutMs: number;          // default: 30000
    ptySilenceThresholdMs: number; // default: 3000
    ptyEnabled: boolean;           // default: true
  };

  // Security
  envDenyList?: string[];
}
```

### SessionStats

```typescript
interface SessionStats {
  sessionId: string;
  consumers: number;
  messageCount: number;
  uptime: number;        // milliseconds since session created
  lastActivity: number;  // Unix timestamp
  cliConnected: boolean;
  pendingPermissions: number;
  queuedMessages: number;
}
```

### RateLimiter

```typescript
interface RateLimiter {
  tryConsume(tokensNeeded?: number): boolean;
  reset(): void;
}
```

Usage:
```typescript
const limiter = new TokenBucketLimiter(
  100,      // capacity
  1000,     // refill interval (ms)
  100       // tokens per interval
);

if (limiter.tryConsume()) {
  // Operation allowed
}
```

### CircuitBreaker

```typescript
interface CircuitBreaker {
  canExecute(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  getState(): "closed" | "open" | "half_open";
}
```

Usage:
```typescript
const breaker = new SlidingWindowBreaker({
  failureThreshold: 5,
  windowMs: 60000,
  recoveryTimeMs: 30000,
  successThreshold: 2,
});

if (breaker.canExecute()) {
  try {
    // Operation
    breaker.recordSuccess();
  } catch (err) {
    breaker.recordFailure();
  }
}
```

### MetricsCollector

```typescript
interface MetricsCollector {
  recordSessionStarted(): void;
  recordSessionEnded(): void;
  recordCLIConnected(sessionId: string): void;
  recordCLIDisconnected(sessionId: string): void;
  recordConsumerConnected(sessionId: string): void;
  recordConsumerDisconnected(sessionId: string): void;
  recordMessageSent(sessionId: string): void;
  recordMessageReceived(sessionId: string): void;
  recordAuthFailure(sessionId: string): void;
  recordProcessRestart(sessionId: string): void;
  recordError(source: string, error: Error): void;
  getMetrics(): Metrics;
}

interface Metrics {
  timestamp: number;
  activeSessions: number;
  connectedCLIs: number;
  connectedConsumers: number;
  messagesSent: number;
  messagesReceived: number;
  authFailures: number;
  processRestarts: number;
  errors: number;
  uptime: number;
}
```

Usage:
```typescript
const metrics = new DefaultMetricsCollector();
const manager = new SessionManager({
  config,
  processManager,
  metrics, // Optional
});

const snapshot = metrics.getMetrics();
console.log(`Sent ${snapshot.messagesSent} messages`);
```

---

## Configuration

### Complete Example

```typescript
import { SessionManager } from "claude-code-bridge";
import { NodeProcessManager } from "claude-code-bridge";
import { FileStorage } from "claude-code-bridge";
import { NodeWebSocketServer } from "claude-code-bridge";

const manager = new SessionManager({
  config: {
    port: 3456,

    // Timeouts
    gitCommandTimeoutMs: 5000,
    authTimeoutMs: 15000,
    shutdownGracePeriodMs: 10000,

    // Resource management
    maxConcurrentSessions: 100,
    idleSessionTimeoutMs: 3600000, // 1 hour
    pendingMessageQueueMaxSize: 500,

    // Rate limiting
    consumerMessageRateLimit: {
      tokensPerSecond: 5000,
      burstSize: 500,
    },

    // Circuit breaker
    cliRestartCircuitBreaker: {
      failureThreshold: 10,
      windowMs: 300000,
      recoveryTimeMs: 60000,
      successThreshold: 3,
    },

    // Slash commands
    slashCommand: {
      ptyTimeoutMs: 30000,
      ptySilenceThresholdMs: 3000,
      ptyEnabled: true,
    },

    // Security
    envDenyList: [
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
    ],
  },

  processManager: new NodeProcessManager(),
  storage: new FileStorage("~/.claude/sessions"),
  server: new NodeWebSocketServer({ port: 3456 }),
});

await manager.start();
console.log("Server listening on port 3456");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  await manager.stop();
  process.exit(0);
});
```

---

## Operational Commands

### SessionOperationalHandler

```typescript
import { SessionOperationalHandler } from "claude-code-bridge";

const handler = new SessionOperationalHandler(sessionManager.bridge);
```

### List Sessions

```typescript
const response = await handler.handle({
  type: "list_sessions",
});

// Response type: ListSessionsResponse[]
interface ListSessionsResponse {
  sessionId: string;
  cliConnected: boolean;
  consumerCount: number;
  messageCount: number;
  uptime: number;
  lastActivity: number;
}

// Example
response.forEach(session => {
  console.log(`${session.sessionId}: ${session.consumerCount} consumers`);
});
```

### Get Session Stats

```typescript
const response = await handler.handle({
  type: "get_session_stats",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});

// Response type: GetSessionStatsResponse
interface GetSessionStatsResponse {
  sessionId: string;
  consumers: number;
  messageCount: number;
  uptime: number;
  lastActivity: number;
  cliConnected: boolean;
  pendingPermissions: number;
  queuedMessages: number;
}
```

### Close Session

```typescript
const response = await handler.handle({
  type: "close_session",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  reason: "Maintenance restart", // optional
});

// Response type: CloseSessionResponse
interface CloseSessionResponse {
  success: boolean;
  sessionId: string;
  message?: string;
}

if (response.success) {
  console.log(`Session closed: ${response.message}`);
}
```

### Archive Session

```typescript
const response = await handler.handle({
  type: "archive_session",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});

// Response type: ArchiveSessionResponse
interface ArchiveSessionResponse {
  success: boolean;
  sessionId: string;
  message?: string;
}
```

### Unarchive Session

```typescript
const response = await handler.handle({
  type: "unarchive_session",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});

// Response type: UnarchiveSessionResponse
```

### Get Health

```typescript
const response = await handler.handle({
  type: "get_health",
});

// Response type: GetHealthResponse
interface GetHealthResponse {
  status: "ok" | "degraded" | "error";
  activeSessions: number;
  cliConnected: number;
  consumerConnections: number;
  uptime: number;
  timestamp: string;
}

console.log(`System status: ${response.status}`);
console.log(`Active sessions: ${response.activeSessions}`);
```

---

## HTTP Endpoints

All endpoints are served by NodeWebSocketServer on the configured port.

### WebSocket

#### CLI Connection
```
ws://localhost:3456/ws/cli/:sessionId
```

CLI process connects here. Sends/receives NDJSON messages.

#### Consumer Connection
```
ws://localhost:3456/ws/consumer/:sessionId?token=xyz
```

Consumer clients connect here. Can include auth token in query string.

### Health Check

```
GET http://localhost:3456/health
```

**Response:**
```json
{
  "status": "ok",
  "sessions": 3,
  "uptime": 3600000,
  "timestamp": "2024-02-14T12:00:00.000Z",
  "cliConnected": 2,
  "consumerCount": 5
}
```

### Session Stats

```
GET http://localhost:3456/stats
```

Get stats for all sessions.

**Response:**
```json
[
  {
    "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "consumers": 2,
    "messageCount": 42,
    "uptime": 3600000,
    "lastActivity": 1645000000000,
    "cliConnected": true,
    "pendingPermissions": 1,
    "queuedMessages": 0
  }
]
```

#### Specific Session

```
GET http://localhost:3456/stats/:sessionId
```

Get stats for a specific session.

**Response:**
```json
{
  "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "consumers": 2,
  "messageCount": 42,
  "uptime": 3600000,
  "lastActivity": 1645000000000,
  "cliConnected": true,
  "pendingPermissions": 1,
  "queuedMessages": 0
}
```

---

## Events

### Message Events

```typescript
manager.on("message:outbound", ({ sessionId, message }) => {
  console.log(`Sent to ${sessionId}:`, message);
});

manager.on("message:inbound", ({ sessionId, message }) => {
  console.log(`Received from ${sessionId}:`, message);
});
```

### Session Events

```typescript
manager.on("session:closed", ({ sessionId }) => {
  console.log(`Session ${sessionId} closed`);
});

manager.on("session:first_turn_completed", ({ sessionId }) => {
  console.log(`First turn completed for ${sessionId}`);
});
```

### Connection Events

```typescript
manager.on("cli:connected", ({ sessionId }) => {
  console.log(`CLI connected to ${sessionId}`);
});

manager.on("consumer:connected", ({ sessionId, consumer }) => {
  console.log(`Consumer connected to ${sessionId}`);
});

manager.on("consumer:disconnected", ({ sessionId, consumer }) => {
  console.log(`Consumer disconnected from ${sessionId}`);
});
```

### Error Events

```typescript
manager.on("error", ({ source, error, sessionId }) => {
  console.error(`Error in ${source} for ${sessionId}:`, error);
});
```

---

## Common Patterns

### Monitor Session Health

```typescript
setInterval(() => {
  const stats = manager.getAllSessionStats();
  stats.forEach(stat => {
    if (!stat.cliConnected) {
      console.warn(`Session ${stat.sessionId} CLI disconnected`);
    }
    if (stat.queuedMessages > 50) {
      console.warn(`Session ${stat.sessionId} has ${stat.queuedMessages} queued`);
    }
  });
}, 10000);
```

### Operational Dashboard

```typescript
const handler = new SessionOperationalHandler(manager.bridge);

app.get("/admin/dashboard", async (req, res) => {
  const sessions = await handler.handle({ type: "list_sessions" });
  const health = await handler.handle({ type: "get_health" });

  res.json({
    health,
    sessions,
    timestamp: new Date().toISOString(),
  });
});
```

### Rate Limit Enforcement

```typescript
const limiter = new TokenBucketLimiter(1000, 1000, 1000);

function validateRateLimit(consumerId: string): boolean {
  if (!limiter.tryConsume()) {
    console.warn(`Rate limit exceeded for ${consumerId}`);
    return false;
  }
  return true;
}
```

### Circuit Breaker Usage

```typescript
const breaker = new SlidingWindowBreaker({
  failureThreshold: 5,
  windowMs: 60000,
  recoveryTimeMs: 30000,
  successThreshold: 2,
});

async function executeWithBreaker(fn: () => Promise<void>) {
  if (!breaker.canExecute()) {
    throw new Error("Circuit breaker is open");
  }

  try {
    await fn();
    breaker.recordSuccess();
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
}
```

---

## Error Handling

Common errors and how to handle them:

### Session Not Found

```typescript
const stats = manager.getSessionStats("nonexistent");
if (!stats) {
  console.log("Session does not exist");
}
```

### Rate Limit Exceeded

```typescript
const limiter = new TokenBucketLimiter(10, 1000, 10);
if (!limiter.tryConsume()) {
  // Handle rate limit: reject request, backoff, etc.
  response.status(429).send("Too many requests");
}
```

### Circuit Breaker Open

```typescript
if (!breaker.canExecute()) {
  // System is failing, don't attempt operation
  response.status(503).send("Service unavailable");
}
```

### Graceful Shutdown

```typescript
process.on("SIGTERM", async () => {
  try {
    await manager.stop(); // Drain consumers, clean up
    process.exit(0);
  } catch (err) {
    console.error("Shutdown error:", err);
    process.exit(1);
  }
});
```

---

## Testing

```typescript
import { SessionManager } from "claude-code-bridge";
import { createTestBridge } from "claude-code-bridge/testing";

// Create test bridge with mocked storage
const bridge = createTestBridge({
  config: { port: 3456 },
  storage: new Map(), // In-memory storage
});

// Test operational handler
const handler = new SessionOperationalHandler(bridge);
const sessions = await handler.handle({ type: "list_sessions" });
expect(sessions).toEqual([]);
```

---

## Version Information

- **Package:** claude-code-bridge
- **Version:** 0.1.0
- **Node.js:** 22.0.0+
- **TypeScript:** 5.0+

---

## License

See LICENSE file in repository.
