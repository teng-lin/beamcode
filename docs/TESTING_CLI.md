# Testing the BeamCode CLI

## Quick Start

```bash
# Build first
npm run build

# Start with tunnel disabled (simplest)
node dist/bin/beamcode.js --no-tunnel

# Or with verbose logging
node dist/bin/beamcode.js --no-tunnel --verbose
```

The server starts, auto-creates a session, and prints:

```
  BeamCode v0.1.0

  Local:   http://localhost:3456

  Session: <uuid>
  CWD:     /path/to/cwd

  Open the local URL on your phone to start coding remotely.

  Press Ctrl+C to stop
```

## What to Test

### 1. HTTP Serving

Open `http://localhost:3456` in a browser. It should:
- Redirect to `http://localhost:3456/?session=<uuid>` (the auto-created session)
- Show the BeamCode consumer UI with a header, message area, and input bar
- Display "Connecting..." then "Connected" in the status dot

```bash
# Verify redirect
curl -v http://localhost:3456/ 2>&1 | grep "< Location"
# → Location: /?session=<uuid>

# Verify HTML
curl -s http://localhost:3456/?session=test | head -3
# → <!DOCTYPE html>

# Health check
curl http://localhost:3456/health
# → {"status":"ok"}

# 404 for unknown paths
curl -o /dev/null -w "%{http_code}" http://localhost:3456/unknown
# → 404
```

### 2. WebSocket Connection

The consumer UI connects via WebSocket automatically. In the browser console you should see the WebSocket establish to `ws://localhost:3456/ws/consumer/<session-id>`.

### 3. CLI Process Launch

When the server starts, it auto-launches `claude` with `--sdk-url` pointing back to the WS server. If `claude` is in your PATH:
- The browser status should show "Connected" (green dot)
- You can type messages in the input bar and get responses

If `claude` is NOT in your PATH, the session will show as connecting but the CLI won't be available. You can specify a different binary:

```bash
node dist/bin/beamcode.js --no-tunnel --claude-binary /path/to/claude
```

### 4. Custom Port

```bash
node dist/bin/beamcode.js --no-tunnel --port 8080
# → Serves on http://localhost:8080
```

Test port conflict:

```bash
# Terminal 1
node dist/bin/beamcode.js --no-tunnel --port 9999

# Terminal 2 (should fail with helpful message)
node dist/bin/beamcode.js --no-tunnel --port 9999 --data-dir /tmp/beamcode-alt
# → Error: Port 9999 is already in use.
# → Try a different port: beamcode --port 10000
```

### 5. Lock File / Single Instance

```bash
# Terminal 1
node dist/bin/beamcode.js --no-tunnel

# Terminal 2 (same data-dir, should fail)
node dist/bin/beamcode.js --no-tunnel
# → Error: Daemon already running (PID: <pid>)

# Use a different data-dir to run a second instance
node dist/bin/beamcode.js --no-tunnel --port 3457 --data-dir /tmp/beamcode2
```

### 6. Graceful Shutdown

Press `Ctrl+C` once:
- Should print "Shutting down..."
- Kills CLI processes, closes WebSocket connections, releases lock file
- Process exits cleanly

Press `Ctrl+C` twice:
- Force exits immediately

Verify lock file is cleaned up:
```bash
ls ~/.beamcode/daemon.lock
# → No such file or directory (good)
```

### 7. Tunnel (requires cloudflared)

```bash
# Install cloudflared first
brew install cloudflared  # macOS

# Start with tunnel
node dist/bin/beamcode.js
```

Should print a tunnel URL like `https://random-words.trycloudflare.com`. Open this URL on your phone to test remote access.

If cloudflared is not installed, the server continues without a tunnel and prints a warning.

### 8. --help

```bash
node dist/bin/beamcode.js --help
```

Should list all options with defaults.

## Testing via npx (after npm link)

```bash
# Link the package locally
npm link

# Run as a CLI
npx beamcode --no-tunnel
# or just
beamcode --no-tunnel
```

## Automated Tests

The existing test suite covers all library components:

```bash
npx vitest run        # All tests
npx vitest run -t "NodeWebSocketServer"  # WS server tests only
```
