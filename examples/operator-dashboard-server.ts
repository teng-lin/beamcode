/**
 * Example: Operational Dashboard Server
 *
 * A complete example showing how to:
 * 1. Set up SessionManager with all production features
 * 2. Add HTTP endpoints for operational commands
 * 3. Add health check endpoint
 * 4. Add stats endpoint
 * 5. Serve an operator dashboard UI
 */

import { createServer } from "node:http";
import { FileStorage } from "../src/adapters/file-storage.js";
import { NodeProcessManager } from "../src/adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../src/adapters/node-ws-server.js";
import { SessionOperationalHandler } from "../src/adapters/session-operational-handler.js";
import { SessionManager } from "../src/index.js";

const PORT = 3456;
const STORAGE_DIR = `${process.env.HOME}/.claude/sessions`;

async function main() {
  console.log("🚀 Starting Operator Dashboard Server...");

  // Initialize SessionManager with all production features
  const manager = new SessionManager({
    config: {
      port: PORT,
      // Resource limits
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
        windowMs: 300000, // 5 minutes
        recoveryTimeMs: 60000, // 1 minute
        successThreshold: 3,
      },
    },
    processManager: new NodeProcessManager(),
    storage: new FileStorage(STORAGE_DIR),
    server: new NodeWebSocketServer({ port: PORT }),
  });

  // Create operational handler
  const operationalHandler = new SessionOperationalHandler(manager.bridge);

  // Create HTTP server with administrative endpoints
  const httpServer = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;
    const method = req.method;

    // Enable CORS for dashboard
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // HEALTH CHECK ENDPOINT
    // ─────────────────────────────────────────────────────────────
    if (pathname === "/health" && method === "GET") {
      try {
        const health = await operationalHandler.handle({
          type: "get_health",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // STATS ENDPOINT
    // ─────────────────────────────────────────────────────────────
    if (pathname.startsWith("/stats") && method === "GET") {
      try {
        const match = pathname.match(/^\/stats(?:\/([^/]+))?$/);
        if (match) {
          const sessionId = match[1];
          const stats = sessionId
            ? await operationalHandler.handle({
                type: "get_session_stats",
                sessionId,
              })
            : await operationalHandler.handle({
                type: "list_sessions",
              });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stats));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid path" }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // OPERATIONAL COMMANDS ENDPOINT (Admin Only)
    // ─────────────────────────────────────────────────────────────
    if (pathname === "/admin/ops" && method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          // TODO: Add authentication check here
          // if (!req.headers.authorization) {
          //   res.writeHead(401, { "Content-Type": "application/json" });
          //   res.end(JSON.stringify({ error: "Unauthorized" }));
          //   return;
          // }

          const command = JSON.parse(body);
          const result = await operationalHandler.handle(command);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // DASHBOARD UI (HTML)
    // ─────────────────────────────────────────────────────────────
    if (pathname === "/" || pathname === "/dashboard" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHTML());
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Start services
  await manager.start();
  httpServer.listen(PORT + 1, "127.0.0.1", () => {
    console.log(`\n✅ Services started!`);
    console.log(`\n📊 Operator Dashboard: http://localhost:${PORT + 1}/`);
    console.log(`\n🌐 WebSocket Server: ws://localhost:${PORT}/`);
    console.log(`\n📈 Health Check: http://localhost:${PORT + 1}/health`);
    console.log(`📋 Stats: http://localhost:${PORT + 1}/stats`);
    console.log(`⚡ Admin Commands: POST http://localhost:${PORT + 1}/admin/ops`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("\n⏹️  Shutting down...");
    await manager.stop();
    httpServer.close();
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────────────
// OPERATOR DASHBOARD HTML UI
// ─────────────────────────────────────────────────────────────

function getDashboardHTML(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Code Bridge - Operator Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      background: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    }
    h1 { color: #333; margin-bottom: 10px; }
    .subtitle { color: #666; font-size: 14px; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    }
    .card h2 {
      color: #333;
      margin-bottom: 15px;
      font-size: 18px;
      border-bottom: 2px solid #667eea;
      padding-bottom: 10px;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #eee;
    }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #666; }
    .stat-value {
      font-weight: bold;
      color: #667eea;
      font-size: 18px;
    }

    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .status-ok { background: #4caf50; color: white; }
    .status-degraded { background: #ff9800; color: white; }
    .status-error { background: #f44336; color: white; }

    .sessions-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    .sessions-table th {
      background: #f5f5f5;
      padding: 10px;
      text-align: left;
      font-weight: bold;
      color: #333;
      border-bottom: 2px solid #ddd;
    }
    .sessions-table td {
      padding: 10px;
      border-bottom: 1px solid #eee;
    }
    .sessions-table tr:hover {
      background: #f9f9f9;
    }

    .buttons {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }
    button {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #667eea;
      color: white;
    }
    .btn-primary:hover {
      background: #5568d3;
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }
    .btn-danger {
      background: #f44336;
      color: white;
    }
    .btn-danger:hover {
      background: #da190b;
    }

    .loading { color: #999; font-style: italic; }
    .error { color: #f44336; }
    .success { color: #4caf50; }

    .refresh-time {
      color: #999;
      font-size: 12px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🚀 Claude Code Bridge - Operator Dashboard</h1>
      <p class="subtitle">Production session management and monitoring</p>
    </header>

    <div class="grid">
      <!-- System Health -->
      <div class="card">
        <h2>System Health</h2>
        <div id="health">
          <div class="loading">Loading...</div>
        </div>
      </div>

      <!-- Quick Stats -->
      <div class="card">
        <h2>Quick Stats</h2>
        <div id="quickstats">
          <div class="loading">Loading...</div>
        </div>
      </div>

      <!-- Actions -->
      <div class="card">
        <h2>Admin Actions</h2>
        <div style="font-size: 12px; color: #999; margin-bottom: 10px;">
          Fast operations
        </div>
        <div class="buttons">
          <button class="btn-primary" onclick="refreshDashboard()">
            🔄 Refresh
          </button>
        </div>
      </div>
    </div>

    <!-- Sessions Table -->
    <div class="card">
      <h2>Active Sessions</h2>
      <div id="sessions">
        <div class="loading">Loading...</div>
      </div>
    </div>

    <div class="refresh-time">
      Last updated: <span id="lastupdate">--</span> | Auto-refresh every 5s
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin;

    async function fetchHealth() {
      try {
        const res = await fetch(\`\${API_BASE}/health\`);
        const data = await res.json();

        const statusClass = \`status-\${data.status}\`;
        document.getElementById('health').innerHTML = \`
          <div style="text-align: center; padding: 20px;">
            <div class="status-badge \${statusClass}">\${data.status.toUpperCase()}</div>
            <div style="margin-top: 15px;">
              <div class="stat">
                <span class="stat-label">Uptime</span>
                <span class="stat-value">\${formatMs(data.uptime)}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Timestamp</span>
                <span class="stat-value">\${new Date(data.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
          </div>
        \`;
      } catch (err) {
        document.getElementById('health').innerHTML = \`
          <div class="error">Failed to load health: \${err.message}</div>
        \`;
      }
    }

    async function fetchSessions() {
      try {
        const res = await fetch(\`\${API_BASE}/stats\`);
        const sessions = await res.json();

        if (!sessions || sessions.length === 0) {
          document.getElementById('sessions').innerHTML =
            '<div class="loading">No active sessions</div>';
          return;
        }

        let html = '<table class="sessions-table"><thead><tr>' +
          '<th>Session ID</th>' +
          '<th>CLI</th>' +
          '<th>Consumers</th>' +
          '<th>Messages</th>' +
          '<th>Uptime</th>' +
          '<th>Actions</th>' +
          '</tr></thead><tbody>';

        for (const session of sessions) {
          const cliStatus = session.cliConnected ? '✅' : '❌';
          html += \`<tr>
            <td style="font-family: monospace; font-size: 12px;">
              \${session.sessionId.substring(0, 8)}...
            </td>
            <td>\${cliStatus}</td>
            <td>\${session.consumerCount}</td>
            <td>\${session.messageCount}</td>
            <td>\${formatMs(session.uptime)}</td>
            <td>
              <button class="btn-danger" style="padding: 5px; font-size: 11px;"
                      onclick="closeSession('\${session.sessionId}')">
                Close
              </button>
            </td>
          </tr>\`;
        }

        html += '</tbody></table>';
        document.getElementById('sessions').innerHTML = html;
      } catch (err) {
        document.getElementById('sessions').innerHTML =
          \`<div class="error">Failed to load sessions: \${err.message}</div>\`;
      }
    }

    async function fetchQuickStats() {
      try {
        const res = await fetch(\`\${API_BASE}/stats\`);
        const sessions = await res.json();

        let totalConsumers = 0;
        let totalMessages = 0;
        for (const session of sessions) {
          totalConsumers += session.consumerCount;
          totalMessages += session.messageCount;
        }

        document.getElementById('quickstats').innerHTML = \`
          <div class="stat">
            <span class="stat-label">Active Sessions</span>
            <span class="stat-value">\${sessions.length}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Connected Consumers</span>
            <span class="stat-value">\${totalConsumers}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Total Messages</span>
            <span class="stat-value">\${totalMessages}</span>
          </div>
        \`;
      } catch (err) {
        document.getElementById('quickstats').innerHTML =
          \`<div class="error">Failed to load stats: \${err.message}</div>\`;
      }
    }

    async function closeSession(sessionId) {
      if (!confirm(\`Close session \${sessionId.substring(0, 8)}...?\`)) return;

      try {
        const res = await fetch(\`\${API_BASE}/admin/ops\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'close_session',
            sessionId,
            reason: 'Operator dashboard'
          })
        });
        const result = await res.json();
        if (result.success) {
          alert('Session closed');
          refreshDashboard();
        } else {
          alert('Failed: ' + result.message);
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function formatMs(ms) {
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms/1000).toFixed(1) + 's';
      if (ms < 3600000) return (ms/60000).toFixed(1) + 'm';
      return (ms/3600000).toFixed(1) + 'h';
    }

    async function refreshDashboard() {
      await Promise.all([
        fetchHealth(),
        fetchSessions(),
        fetchQuickStats()
      ]);
      document.getElementById('lastupdate').textContent =
        new Date().toLocaleTimeString();
    }

    // Initial load and auto-refresh
    refreshDashboard();
    setInterval(refreshDashboard, 5000);
  </script>
</body>
</html>
  `;
}

main().catch(console.error);
