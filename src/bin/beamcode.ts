import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createAdapterResolver } from "../adapters/adapter-resolver.js";
import { ClaudeLauncher } from "../adapters/claude/claude-launcher.js";
import { CompositeMetricsCollector } from "../adapters/composite-metrics-collector.js";
import { ConsoleMetricsCollector } from "../adapters/console-metrics-collector.js";
import { CLI_ADAPTER_NAMES, type CliAdapterName } from "../adapters/create-adapter.js";
import { DefaultGitResolver } from "../adapters/default-git-resolver.js";
import { ErrorAggregator } from "../adapters/error-aggregator.js";
import { FileStorage } from "../adapters/file-storage.js";
import { NodeProcessManager } from "../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import type { PrometheusMetricsCollector } from "../adapters/prometheus-metrics-collector.js";
import { LogLevel, StructuredLogger } from "../adapters/structured-logger.js";
import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";

import {
  type MessageTracer,
  MessageTracerImpl,
  noopTracer,
  type TraceLevel,
} from "../core/message-tracer.js";
import {
  type CoreRuntimeMode,
  DEFAULT_CORE_RUNTIME_MODE,
  resolveCoreRuntimeMode,
} from "../core/runtime-mode.js";
import { SessionCoordinator } from "../core/session-coordinator.js";
import { Daemon } from "../daemon/daemon.js";
import { injectConsumerToken, loadConsumerHtml } from "../http/consumer-html.js";
import { createBeamcodeServer } from "../http/server.js";
import { CloudflaredManager } from "../relay/cloudflared-manager.js";
import { ApiKeyAuthenticator } from "../server/api-key-authenticator.js";
import { OriginValidator } from "../server/origin-validator.js";
import { resolvePackageVersion } from "../utils/resolve-package-version.js";

const version = resolvePackageVersion(import.meta.url, [
  "../../package.json",
  "../../../package.json",
  "../package.json",
]);

// ── Types ──────────────────────────────────────────────────────────────────

interface CliConfig {
  port: number;
  noTunnel: boolean;
  noAutoLaunch: boolean;
  tunnelToken?: string;
  dataDir: string;
  model?: string;
  cwd: string;
  claudeBinary: string;
  verbose: boolean;
  adapter?: CliAdapterName;
  trace: boolean;
  traceLevel: TraceLevel;
  traceAllowSensitive: boolean;
  prometheus?: boolean;
  coreRuntimeMode: CoreRuntimeMode;
}

// ── Arg parsing ────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  BeamCode — code anywhere via your phone

  Usage: beamcode [options]

  Options:
    --port <n>             WebSocket/HTTP port (default: 9414)
    --no-tunnel            Skip cloudflared tunnel
    --tunnel-token <tok>   Use production tunnel with token
    --data-dir <path>      Runtime data directory (default: ~/.beamcode)
    --model <name>         Model to pass to Claude CLI
    --cwd <path>           Working directory for CLI (default: cwd)
    --claude-binary <path> Path to claude binary (default: "claude")
    --default-adapter <name>  Default backend: claude (default), codex, acp
    --adapter <name>          Alias for --default-adapter
    --core-runtime-mode <m>   Core runtime mode: legacy (default), vnext_shadow
    --no-auto-launch       Start server without creating an initial session
    --trace                Enable message tracing (NDJSON to stderr)
    --trace-level <level>  Trace detail: smart (default), headers, full
    --trace-allow-sensitive  Allow sensitive payload logging with --trace-level full
    --prometheus            Enable Prometheus metrics on /metrics endpoint
    --verbose, -v          Verbose logging
    --help, -h             Show this help

  Environment:
    BEAMCODE_TRACE=1
    BEAMCODE_TRACE_LEVEL=smart|headers|full
    BEAMCODE_TRACE_ALLOW_SENSITIVE=1
    BEAMCODE_CORE_RUNTIME_MODE=legacy|vnext_shadow
`);
}

function validateAdapterName(value: string, source: string): CliAdapterName {
  if (!CLI_ADAPTER_NAMES.includes(value as CliAdapterName)) {
    console.error(`Error: ${source} must be one of: ${CLI_ADAPTER_NAMES.join(", ")}`);
    process.exit(1);
  }
  return value as CliAdapterName;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

function parseArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    port: 9414,
    noTunnel: false,
    noAutoLaunch: false,
    dataDir: join(process.env.HOME ?? "~", ".beamcode"),
    cwd: process.cwd(),
    claudeBinary: "claude",
    verbose: false,
    trace: false,
    traceLevel: "smart",
    traceAllowSensitive: false,
    coreRuntimeMode: DEFAULT_CORE_RUNTIME_MODE,
  };
  let traceExplicit = false;
  let traceLevelExplicit = false;
  let traceAllowSensitiveExplicit = false;

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
      case "--adapter":
      case "--default-adapter":
        config.adapter = validateAdapterName(argv[++i], arg);
        break;
      case "--core-runtime-mode":
        try {
          config.coreRuntimeMode = resolveCoreRuntimeMode(argv[++i]);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        break;
      case "--no-auto-launch":
        config.noAutoLaunch = true;
        break;
      case "--trace":
        config.trace = true;
        traceExplicit = true;
        break;
      case "--trace-level": {
        const level = argv[++i];
        if (!["smart", "headers", "full"].includes(level)) {
          console.error("Error: --trace-level must be smart, headers, or full");
          process.exit(1);
        }
        config.traceLevel = level as TraceLevel;
        traceLevelExplicit = true;
        break;
      }
      case "--trace-allow-sensitive":
        config.traceAllowSensitive = true;
        traceAllowSensitiveExplicit = true;
        break;
      case "--prometheus":
        config.prometheus = true;
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

  if (!config.adapter && process.env.BEAMCODE_ADAPTER) {
    config.adapter = validateAdapterName(process.env.BEAMCODE_ADAPTER, "BEAMCODE_ADAPTER");
  }

  if (!config.noAutoLaunch && process.env.BEAMCODE_NO_AUTO_LAUNCH === "1") {
    config.noAutoLaunch = true;
  }

  if (!traceExplicit && process.env.BEAMCODE_TRACE) {
    config.trace = isTruthyEnv(process.env.BEAMCODE_TRACE);
  }

  const traceLevelEnv = process.env.BEAMCODE_TRACE_LEVEL;
  if (!traceLevelExplicit && traceLevelEnv) {
    if (!["smart", "headers", "full"].includes(traceLevelEnv)) {
      console.error("Error: BEAMCODE_TRACE_LEVEL must be smart, headers, or full");
      process.exit(1);
    }
    config.traceLevel = traceLevelEnv as TraceLevel;
  }

  if (!traceAllowSensitiveExplicit && process.env.BEAMCODE_TRACE_ALLOW_SENSITIVE) {
    config.traceAllowSensitive = isTruthyEnv(process.env.BEAMCODE_TRACE_ALLOW_SENSITIVE);
  }

  if (process.env.BEAMCODE_CORE_RUNTIME_MODE) {
    try {
      config.coreRuntimeMode = resolveCoreRuntimeMode(process.env.BEAMCODE_CORE_RUNTIME_MODE);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  if (config.traceLevel === "full" && !config.traceAllowSensitive) {
    console.error("Error: --trace-level full requires --trace-allow-sensitive");
    process.exit(1);
  }

  if (!config.trace && (config.traceLevel !== "smart" || config.traceAllowSensitive)) {
    console.warn(
      "Warning: --trace-level and --trace-allow-sensitive have no effect without --trace",
    );
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

  // Create message tracer (noop when --trace is not set)
  const tracer: MessageTracer = config.trace
    ? new MessageTracerImpl({
        level: config.traceLevel,
        allowSensitive: config.traceAllowSensitive,
      })
    : noopTracer;

  if (config.trace) {
    console.warn(
      `[trace] Message tracing enabled (level=${config.traceLevel}). NDJSON trace events will be written to stderr.${
        config.traceAllowSensitive ? " WARNING: sensitive payload logging is enabled." : ""
      }`,
    );
  }

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

  // 3. Create SessionCoordinator (started after HTTP+WS servers are ready)
  const storage = new FileStorage(config.dataDir);
  const errorAggregator = new ErrorAggregator();
  let metrics: import("../interfaces/metrics.js").MetricsCollector = new ConsoleMetricsCollector(
    logger,
    errorAggregator,
  );
  const processManager = new NodeProcessManager();
  const adapterResolver = createAdapterResolver({ processManager, logger }, config.adapter);
  const adapter = adapterResolver.resolve(config.adapter);

  const providerConfig = {
    port: config.port,
    defaultClaudeBinary: config.claudeBinary,
    cliWebSocketUrlTemplate: (sessionId: string) =>
      `ws://127.0.0.1:${config.port}/ws/cli/${sessionId}`,
  };

  const launcher = new ClaudeLauncher({
    processManager,
    config: providerConfig,
    storage,
    logger,
  });

  // 4. Generate a single consumer token used for both HTTP API auth and WS auth.
  // The token is embedded in the HTML page so the browser can authenticate
  // API requests (e.g. creating sessions). When a tunnel is active, the same
  // token also guards WebSocket connections, since tunnel-forwarded requests
  // bypass bind-address and origin checks.
  const consumerToken = randomBytes(24).toString("base64url");
  injectConsumerToken(consumerToken);

  // ── Prometheus opt-in (may reassign metrics) ──
  let prometheusCollector: PrometheusMetricsCollector | undefined;
  if (config.prometheus || process.env.BEAMCODE_PROMETHEUS === "1") {
    try {
      const promClient = await import("prom-client");
      const { PrometheusMetricsCollector: PromCollector } = await import(
        "../adapters/prometheus-metrics-collector.js"
      );
      prometheusCollector = new PromCollector(promClient.default ?? promClient);
      const consoleMetrics = metrics;
      metrics = new CompositeMetricsCollector([consoleMetrics, prometheusCollector]);
      logger.info("Prometheus metrics enabled", { component: "startup" });
    } catch (err) {
      logger.warn(
        `Prometheus metrics disabled: ${err instanceof Error ? err.message : String(err)}`,
        { component: "startup" },
      );
    }
  }

  // When a tunnel is active, enforce token auth on consumer WebSocket connections.
  // Tunnel-forwarded requests bypass bind-address and origin checks, so the only
  // protection would be UUID unpredictability without this authenticator.
  const authenticator = tunnelUrl ? new ApiKeyAuthenticator(consumerToken) : undefined;

  const sessionCoordinator = new SessionCoordinator({
    config: providerConfig,
    storage,
    logger,
    metrics,
    gitResolver: new DefaultGitResolver(),
    adapter,
    adapterResolver,
    launcher,
    authenticator,
    rateLimiterFactory: (burstSize, refillIntervalMs, tokensPerInterval) =>
      new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval),
    tracer,
    runtimeMode: config.coreRuntimeMode,
  });

  const httpServer = createBeamcodeServer({
    sessionCoordinator,
    activeSessionId: "",
    apiKey: consumerToken,
    healthContext: { version, metrics },
    prometheusCollector,
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

  // 6. Attach WebSocket server and start SessionCoordinator
  const wsServer = new NodeWebSocketServer({
    port: config.port,
    server: httpServer,
    originValidator: new OriginValidator(),
  });
  sessionCoordinator.setServer(wsServer);
  await sessionCoordinator.start();

  // 7. Auto-launch a session AFTER WS is ready so the CLI can connect
  let activeSessionId = "";

  if (!config.noAutoLaunch) {
    try {
      const session = await sessionCoordinator.createSession({
        cwd: config.cwd,
        model: config.model,
        adapterName: adapterResolver.defaultName,
      });
      activeSessionId = session.sessionId;
    } catch (err) {
      console.error(
        `Error: Failed to start ${adapter.name} backend: ${err instanceof Error ? err.message : err}`,
      );
      console.error(`Is the ${adapter.name} CLI installed and available on your PATH?`);
      process.exit(1);
    }
  }

  httpServer.setActiveSessionId(activeSessionId);

  // 8. Print startup banner
  const localUrl = `http://localhost:${config.port}`;
  const tunnelSessionUrl =
    tunnelUrl && activeSessionId ? `${tunnelUrl}/?session=${activeSessionId}` : null;
  console.log(`
  BeamCode v${version}

  Local:   ${localUrl}${tunnelSessionUrl ? `\n  Tunnel:  ${tunnelSessionUrl}` : ""}
${activeSessionId ? `\n  Session: ${activeSessionId}` : ""}
  Adapter: ${adapter.name}${config.noAutoLaunch ? " (no auto-launch)" : ""}
  CWD:     ${config.cwd}
  API Key: ${consumerToken}

  Open ${tunnelSessionUrl ? "the tunnel URL" : "the local URL"} on your phone to start coding remotely.
  API requests require: Authorization: Bearer ${consumerToken}

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
      await sessionCoordinator.stop();
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
