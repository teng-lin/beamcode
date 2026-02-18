#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ConsoleMetricsCollector } from "../adapters/console-metrics-collector.js";
import { FileStorage } from "../adapters/file-storage.js";
import { NodeProcessManager } from "../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { LogLevel, StructuredLogger } from "../adapters/structured-logger.js";
import { SessionManager } from "../core/session-manager.js";
import { Daemon } from "../daemon/daemon.js";
import { injectApiKey, loadConsumerHtml } from "../http/consumer-html.js";
import { createBeamcodeServer } from "../http/server.js";
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const logger = new StructuredLogger({
    component: "beamcode",
    level: config.verbose ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Pre-load consumer HTML (also caches gzipped version).
  // API key injection happens after key generation (step 4).
  loadConsumerHtml();

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

  // 2. Start CloudflaredManager (unless --no-tunnel) — start early so we know tunnel state
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

  // 3. Create SessionManager (started after HTTP+WS servers are ready)
  const storage = new FileStorage(config.dataDir);
  const metrics = new ConsoleMetricsCollector(logger);
  const sessionManager = new SessionManager({
    config: {
      port: config.port,
      defaultClaudeBinary: config.claudeBinary,
      cliWebSocketUrlTemplate: (sessionId: string) =>
        `ws://127.0.0.1:${config.port}/ws/cli/${sessionId}`,
    },
    processManager: new NodeProcessManager(),
    storage,
    logger,
    metrics,
  });

  // 4. Generate API key, inject into HTML, and create HTTP server
  const apiKey = randomBytes(24).toString("base64url");
  injectApiKey(apiKey);
  const httpServer = createBeamcodeServer({
    sessionManager,
    activeSessionId: "",
    apiKey,
  });

  // 5. Start HTTP server and wait for it to be listening
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

  // 6. Attach WebSocket server and start SessionManager
  const wsServer = new NodeWebSocketServer({
    port: config.port,
    server: httpServer,
    originValidator: new OriginValidator(),
  });
  sessionManager.setServer(wsServer);
  await sessionManager.start();

  // 7. Auto-launch a session AFTER WS is ready so the CLI can connect
  const session = sessionManager.launcher.launch({
    cwd: config.cwd,
    model: config.model,
  });
  const activeSessionId = session.sessionId;
  httpServer.setActiveSessionId(activeSessionId);

  // 8. Print startup banner
  const localUrl = `http://localhost:${config.port}`;
  const tunnelSessionUrl = tunnelUrl ? `${tunnelUrl}/?session=${activeSessionId}` : null;
  console.log(`
  BeamCode v0.1.0

  Local:   ${localUrl}${tunnelSessionUrl ? `\n  Tunnel:  ${tunnelSessionUrl}` : ""}

  Session: ${activeSessionId}
  CWD:     ${config.cwd}
  API Key: ${apiKey}

  Open ${tunnelSessionUrl ? "the tunnel URL" : "the local URL"} on your phone to start coding remotely.
  API requests require: Authorization: Bearer ${apiKey}

  Press Ctrl+C to stop
`);

  // 9. Graceful shutdown
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const shutdown = async () => {
    if (shuttingDown) {
      console.log("\n  Force exiting...");
      if (forceExitTimer) clearTimeout(forceExitTimer);
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\n  Shutting down...");

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
