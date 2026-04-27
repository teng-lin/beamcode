import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
} from "../core/messaging/message-tracer.js";
import { SessionCoordinator } from "../core/session-coordinator.js";
import { Daemon } from "../daemon/daemon.js";
import { injectConsumerAuthTokens, loadConsumerHtml } from "../http/consumer-html.js";
import { createBeamcodeServer } from "../http/server.js";
import { CloudflaredManager } from "../relay/cloudflared-manager.js";
import { ApiKeyAuthenticator } from "../server/api-key-authenticator.js";
import { OriginValidator } from "../server/origin-validator.js";
import { RotatingTokenAuthority } from "../server/rotating-token-authority.js";
import { resolvePackageVersion } from "../utils/resolve-package-version.js";
import { pickMostRecentSessionId, reconcileActiveSessionId } from "./active-session-id.js";

const version = resolvePackageVersion(import.meta.url, [
  "../../package.json",
  "../../../package.json",
  "../package.json",
]);

const API_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const API_TOKEN_ROTATE_MS = 60 * 60 * 1000;
const CONSUMER_WS_TOKEN_TTL_MS = 60 * 60 * 1000;
const CONSUMER_WS_TOKEN_ROTATE_MS = 15 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface CliConfig {
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

export function parseArgs(argv: string[]): CliConfig {
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

interface ServiceStopper {
  stop(): Promise<void>;
}

interface ClosableServer {
  close(callback: () => void): void;
}

export interface ShutdownHandlerDeps {
  sessionCoordinator: ServiceStopper;
  cloudflared: ServiceStopper;
  daemon: ServiceStopper;
  httpServer: ClosableServer;
  onBeforeStop?: () => void | Promise<void>;
  timeoutMs?: number;
  onExit?: (code: number) => void;
  logger?: Pick<typeof console, "log" | "error">;
}

export function createShutdownHandler({
  sessionCoordinator,
  cloudflared,
  daemon,
  httpServer,
  onBeforeStop,
  timeoutMs = 10_000,
  onExit = (code: number) => process.exit(code),
  logger = console,
}: ShutdownHandlerDeps): () => Promise<void> {
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    onExit(code);
  };

  return async () => {
    if (shuttingDown) {
      logger.log("\n  Force exiting...");
      exitOnce(1);
      return;
    }
    shuttingDown = true;
    logger.log("\n  Shutting down...");

    if (onBeforeStop) {
      try {
        await onBeforeStop();
      } catch (err) {
        logger.error(
          `  Pre-shutdown hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    forceExitTimer = setTimeout(() => {
      logger.error("  Shutdown timed out, force exiting.");
      exitOnce(1);
    }, timeoutMs);

    await Promise.allSettled([sessionCoordinator.stop(), cloudflared.stop(), daemon.stop()]);

    await new Promise<void>((resolve) => {
      try {
        httpServer.close(() => resolve());
      } catch {
        resolve();
      }
    });

    exitOnce(0);
  };
}

export function isCliEntrypoint(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    const modulePath = realpathSync(fileURLToPath(metaUrl));
    const entryPath = realpathSync(resolve(argv1));
    return modulePath === entryPath;
  } catch {
    return metaUrl === pathToFileURL(resolve(argv1)).href;
  }
}

export async function runBeamcode(argv: string[] = process.argv): Promise<void> {
  const config = parseArgs(argv);
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
      console.error(
        "Note: separate --data-dir instances do not share session state and are not horizontally coordinated.",
      );
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

  // 4. Generate scoped tokens:
  // - apiToken: authenticates HTTP API requests
  // - consumerWsToken: authenticates consumer WebSocket connections
  // Both are injected into consumer HTML under distinct meta tags.
  const apiTokens = new RotatingTokenAuthority({ ttlMs: API_TOKEN_TTL_MS, maxActiveTokens: 16 });
  const consumerWsTokens = new RotatingTokenAuthority({
    ttlMs: CONSUMER_WS_TOKEN_TTL_MS,
    maxActiveTokens: 16,
  });
  let apiToken = apiTokens.rotate().token;
  let consumerWsToken = consumerWsTokens.rotate().token;
  injectConsumerAuthTokens({ apiToken, consumerToken: consumerWsToken });

  const apiTokenTimer = setInterval(() => {
    apiToken = apiTokens.rotate().token;
    injectConsumerAuthTokens({ apiToken });
  }, API_TOKEN_ROTATE_MS);
  apiTokenTimer.unref();

  const consumerWsTokenTimer = setInterval(() => {
    consumerWsToken = consumerWsTokens.rotate().token;
    injectConsumerAuthTokens({ consumerToken: consumerWsToken });
  }, CONSUMER_WS_TOKEN_ROTATE_MS);
  consumerWsTokenTimer.unref();

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
  const authenticator = tunnelUrl
    ? new ApiKeyAuthenticator((token) => consumerWsTokens.validate(token))
    : undefined;

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
  });

  let activeSessionId = "";
  logger.warn(
    "Session state is process-local to this BeamCode instance; horizontal scaling requires external coordination that is not enabled in this runtime.",
    { component: "startup", topology: "single-node", sessionStateScope: "process-local" },
  );

  const httpServer = createBeamcodeServer({
    sessionCoordinator,
    activeSessionId,
    apiKeyValidator: (token) => apiTokens.validate(token),
    healthContext: {
      version,
      metrics,
      deployment: {
        topology: "single-node",
        sessionStateScope: "process-local",
        horizontalScaling: "unsupported",
      },
    },
    prometheusCollector,
  });

  // 5. Start HTTP server and wait for it to be listening
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Error: Port ${config.port} is already in use.`);
        console.error(`Try a different port: beamcode --port ${config.port + 1}`);
        await Promise.allSettled([cloudflared.stop(), daemon.stop()]);
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

  const setActiveSessionId = (nextSessionId: string) => {
    activeSessionId = nextSessionId;
    httpServer.setActiveSessionId(nextSessionId);
  };

  const syncActiveSessionId = () => {
    const sessions = sessionCoordinator.registry.listSessions();
    setActiveSessionId(reconcileActiveSessionId(activeSessionId, sessions));
  };

  // Keep root redirect target synchronized with coordinator lifecycle events.
  sessionCoordinator.on("process:spawned", ({ sessionId }) => {
    setActiveSessionId(sessionId);
  });
  sessionCoordinator.on("backend:connected", ({ sessionId }) => {
    setActiveSessionId(sessionId);
  });
  sessionCoordinator.on("session:closed", () => {
    syncActiveSessionId();
  });

  await sessionCoordinator.start();
  setActiveSessionId(pickMostRecentSessionId(sessionCoordinator.registry.listSessions()));

  // 7. Auto-launch a session AFTER WS is ready so the CLI can connect.
  // Skip if sessions were already restored from storage — the consumer UI will
  // show them and the user can create new ones via the dialog.
  const existingSessions = sessionCoordinator.registry.listSessions();
  if (!config.noAutoLaunch && existingSessions.length === 0) {
    try {
      const session = await sessionCoordinator.createSession({
        cwd: config.cwd,
        model: config.model,
        adapterName: adapterResolver.defaultName,
      });
      setActiveSessionId(session.sessionId);
    } catch (err) {
      console.error(
        `Error: Failed to start ${adapter.name} backend: ${err instanceof Error ? err.message : err}`,
      );
      console.error(`Is the ${adapter.name} CLI installed and available on your PATH?`);
      await Promise.allSettled([sessionCoordinator.stop(), cloudflared.stop(), daemon.stop()]);
      process.exit(1);
    }
  }

  // 8. Print startup banner
  const localUrl = `http://localhost:${config.port}`;
  const tunnelSessionUrl =
    tunnelUrl && activeSessionId ? `${tunnelUrl}/?session=${activeSessionId}` : null;
  const tokenRotationInfo = `API key rotates every ${Math.floor(API_TOKEN_ROTATE_MS / 60_000)}m (ttl ${Math.floor(API_TOKEN_TTL_MS / 60_000)}m); WS token rotates every ${Math.floor(CONSUMER_WS_TOKEN_ROTATE_MS / 60_000)}m (ttl ${Math.floor(CONSUMER_WS_TOKEN_TTL_MS / 60_000)}m)`;
  console.log(`
  BeamCode v${version}

  Local:   ${localUrl}${tunnelSessionUrl ? `\n  Tunnel:  ${tunnelSessionUrl}` : ""}
${activeSessionId ? `\n  Session: ${activeSessionId}` : ""}
  Adapter: ${adapter.name}${config.noAutoLaunch ? " (no auto-launch)" : ""}
  Topology: single-node (process-local session state)
  CWD:     ${config.cwd}
  API Key: ${apiToken}
  Auth:    ${tokenRotationInfo}

  Open ${tunnelSessionUrl ? "the tunnel URL" : "the local URL"} on your phone to start coding remotely.
  API requests require: Authorization: Bearer ${apiToken}

  Press Ctrl+C to stop
`);

  // 9. Graceful shutdown
  const shutdown = createShutdownHandler({
    sessionCoordinator,
    cloudflared,
    daemon,
    httpServer,
    onBeforeStop: () => {
      clearInterval(apiTokenTimer);
      clearInterval(consumerWsTokenTimer);
      apiTokens.revokeAll();
      consumerWsTokens.revokeAll();
    },
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isCliEntrypoint(import.meta.url)) {
  runBeamcode().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
