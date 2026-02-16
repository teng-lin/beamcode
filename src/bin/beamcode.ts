#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConsoleLogger } from "../adapters/console-logger.js";
import { FileStorage } from "../adapters/file-storage.js";
import { NodeProcessManager } from "../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { SessionManager } from "../core/session-manager.js";
import { Daemon } from "../daemon/daemon.js";
import { CloudflaredManager } from "../relay/cloudflared-manager.js";
import { OriginValidator } from "../server/origin-validator.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface CliConfig {
  port: number;
  noTunnel: boolean;
  tunnelToken?: string;
  dataDir: string;
  model?: string;
  cwd: string;
  claudeBinary: string;
  verbose: boolean;
}

// ── Arg parsing ────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  BeamCode — code anywhere via your phone

  Usage: beamcode [options]

  Options:
    --port <n>             WebSocket/HTTP port (default: 3456)
    --no-tunnel            Skip cloudflared tunnel
    --tunnel-token <tok>   Use production tunnel with token
    --data-dir <path>      Runtime data directory (default: ~/.beamcode)
    --model <name>         Model to pass to Claude CLI
    --cwd <path>           Working directory for CLI (default: cwd)
    --claude-binary <path> Path to claude binary (default: "claude")
    --verbose, -v          Verbose logging
    --help, -h             Show this help
`);
}

function parseArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    port: 3456,
    noTunnel: false,
    dataDir: join(process.env.HOME ?? "~", ".beamcode"),
    cwd: process.cwd(),
    claudeBinary: "claude",
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        config.port = Number.parseInt(argv[++i], 10);
        if (Number.isNaN(config.port)) {
          console.error("Error: --port requires a number");
          process.exit(1);
        }
        break;
      case "--no-tunnel":
        config.noTunnel = true;
        break;
      case "--tunnel-token":
        config.tunnelToken = argv[++i];
        break;
      case "--data-dir":
        config.dataDir = argv[++i];
        break;
      case "--model":
        config.model = argv[++i];
        break;
      case "--cwd":
        config.cwd = argv[++i];
        break;
      case "--claude-binary":
        config.claudeBinary = argv[++i];
        break;
      case "--verbose":
      case "-v":
        config.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}\nRun with --help for usage.`);
        process.exit(1);
    }
  }

  return config;
}

// ── Consumer HTML ──────────────────────────────────────────────────────────

function loadConsumerHtml(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Try dist layout first (compiled: dist/bin/beamcode.js → dist/consumer/index.html)
  const distPath = join(__dirname, "..", "consumer", "index.html");
  try {
    return readFileSync(distPath, "utf-8");
  } catch {
    // Fall back to source layout (running from src via tsx)
    const srcPath = join(__dirname, "..", "consumer", "index.html");
    return readFileSync(srcPath, "utf-8");
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const logger = new ConsoleLogger();
  const html = loadConsumerHtml();

  // 1. Start daemon (lock file, state file, health check)
  const daemon = new Daemon();
  try {
    await daemon.start({ dataDir: config.dataDir, port: config.port });
  } catch (err) {
    if (err instanceof Error && err.message.includes("already running")) {
      console.error(`Error: ${err.message}`);
      console.error("Stop the other instance first, or use a different --data-dir.");
      process.exit(1);
    }
    throw err;
  }

  // 2. Create HTTP server (serves consumer HTML; sessionId set after launch)
  let activeSessionId = "";
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Redirect bare / to /?session=<id> so the consumer connects automatically
    if (url.pathname === "/" && !url.searchParams.has("session") && activeSessionId) {
      res.writeHead(302, { Location: `/?session=${activeSessionId}` });
      res.end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      });
      res.end(html);
      return;
    }
    // Health check endpoint
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  // 3. Start HTTP server and wait for it to be listening
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Error: Port ${config.port} is already in use.`);
        console.error(`Try a different port: beamcode --port ${config.port + 1}`);
        process.exit(1);
      }
      reject(err);
    });
    httpServer.listen(config.port, () => resolve());
  });

  // 4. Attach WebSocket server to HTTP server
  const wsServer = new NodeWebSocketServer({
    port: config.port,
    server: httpServer,
    originValidator: new OriginValidator(),
  });

  // 5. Start CloudflaredManager (unless --no-tunnel)
  const cloudflared = new CloudflaredManager();
  let tunnelUrl: string | null = null;

  if (!config.noTunnel) {
    try {
      const mode = config.tunnelToken ? "production" : "development";
      const result = await cloudflared.start({
        mode,
        localPort: config.port,
        tunnelToken: config.tunnelToken,
      });
      tunnelUrl = result.url;
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found in PATH")) {
        console.warn(`\n  Warning: ${err.message}`);
        console.warn("  Continuing without tunnel. Use --no-tunnel to suppress this warning.\n");
      } else {
        console.error(`Tunnel error: ${err instanceof Error ? err.message : err}`);
        console.warn("  Continuing without tunnel.\n");
      }
    }
  }

  // 6. Create and start SessionManager
  const storage = new FileStorage(config.dataDir);
  const sessionManager = new SessionManager({
    config: {
      port: config.port,
      defaultClaudeBinary: config.claudeBinary,
      cliWebSocketUrlTemplate: (sessionId: string) =>
        `ws://127.0.0.1:${config.port}/ws/cli/${sessionId}`,
    },
    processManager: new NodeProcessManager(),
    storage,
    logger: config.verbose ? logger : undefined,
    server: wsServer,
  });

  await sessionManager.start();

  // 7. Auto-launch a session so the browser "just works"
  const session = sessionManager.launcher.launch({
    cwd: config.cwd,
    model: config.model,
  });
  activeSessionId = session.sessionId;

  // 8. Print startup banner
  const localUrl = `http://localhost:${config.port}`;
  const tunnelSessionUrl = tunnelUrl ? `${tunnelUrl}/?session=${activeSessionId}` : null;
  console.log(`
  BeamCode v0.1.0

  Local:   ${localUrl}${tunnelSessionUrl ? `\n  Tunnel:  ${tunnelSessionUrl}` : ""}

  Session: ${activeSessionId}
  CWD:     ${config.cwd}

  Open ${tunnelSessionUrl ? "the tunnel URL" : "the local URL"} on your phone to start coding remotely.

  Press Ctrl+C to stop
`);

  // 8. Graceful shutdown
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const shutdown = async () => {
    if (shuttingDown) {
      // Double Ctrl+C → force exit
      console.log("\n  Force exiting...");
      if (forceExitTimer) clearTimeout(forceExitTimer);
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\n  Shutting down...");

    // Force exit after 10s if graceful shutdown stalls
    forceExitTimer = setTimeout(() => {
      console.error("  Shutdown timed out, force exiting.");
      process.exit(1);
    }, 10_000);

    try {
      await sessionManager.stop();
    } catch {
      // best-effort
    }
    try {
      await cloudflared.stop();
    } catch {
      // best-effort
    }
    try {
      await daemon.stop();
    } catch {
      // best-effort
    }

    httpServer.close(() => {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
