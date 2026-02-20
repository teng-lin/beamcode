/**
 * Generic real-backend session setup for e2e tests.
 *
 * Uses AdapterResolver + SessionManager.createSession() to set up
 * sessions for any backend adapter (codex, gemini, opencode, claude).
 */

import { createAdapterResolver } from "../../adapters/adapter-resolver.js";
import { ClaudeLauncher } from "../../adapters/claude/claude-launcher.js";
import type { CliAdapterName } from "../../adapters/create-adapter.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { NodeProcessManager } from "../../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import {
  MessageTracerImpl,
  noopTracer,
  type MessageTracer,
  type TraceLevel,
} from "../../core/message-tracer.js";
import { SessionManager } from "../../core/session-manager.js";
import type { Authenticator } from "../../interfaces/auth.js";
import type { LauncherStateStorage, SessionStorage } from "../../interfaces/storage.js";
import { attachTrace, reservePort } from "./helpers.js";

export interface SetupRealSessionOptions {
  config?: { initializeTimeoutMs?: number; reconnectGracePeriodMs?: number };
  storage?: SessionStorage;
  authenticator?: Authenticator;
}

export interface RealSessionContext {
  manager: SessionManager;
  server: NodeWebSocketServer;
  sessionId: string;
  port: number;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

function resolveTraceLevel(value: string | undefined): TraceLevel {
  return value === "headers" || value === "full" || value === "smart" ? value : "smart";
}

function createEnvTracer(): MessageTracer {
  if (!isTruthyEnv(process.env.BEAMCODE_TRACE)) {
    return noopTracer;
  }

  return new MessageTracerImpl({
    level: resolveTraceLevel(process.env.BEAMCODE_TRACE_LEVEL),
    allowSensitive: isTruthyEnv(process.env.BEAMCODE_TRACE_ALLOW_SENSITIVE),
  });
}

function isLauncherStateStorage(storage: SessionStorage): storage is SessionStorage & LauncherStateStorage {
  return (
    "saveLauncherState" in storage &&
    typeof storage.saveLauncherState === "function" &&
    "loadLauncherState" in storage &&
    typeof storage.loadLauncherState === "function"
  );
}

/**
 * Set up a real backend session using SessionManager.createSession().
 *
 * Works for all adapter types: claude, codex, gemini, opencode.
 */
export async function setupRealSession(
  adapterName: CliAdapterName,
  options?: SetupRealSessionOptions,
): Promise<RealSessionContext> {
  const port = await reservePort();
  const server = new NodeWebSocketServer({ port });
  const processManager = new NodeProcessManager();
  const config = {
    port,
    initializeTimeoutMs: options?.config?.initializeTimeoutMs ?? 20_000,
    reconnectGracePeriodMs: options?.config?.reconnectGracePeriodMs ?? 10_000,
  };
  const tracer = createEnvTracer();
  const memStorage = new MemoryStorage();
  const storage = options?.storage ?? memStorage;
  const launcherStorage = isLauncherStateStorage(storage) ? storage : memStorage;

  const adapterResolver = createAdapterResolver({ processManager }, adapterName);

  const manager = new SessionManager({
    config,
    storage,
    server,
    adapterResolver,
    authenticator: options?.authenticator,
    launcher: new ClaudeLauncher({ processManager, config, storage: launcherStorage }),
    tracer,
  });

  attachTrace(manager);
  await manager.start();

  try {
    const result = await manager.createSession({
      adapterName,
      cwd: process.cwd(),
    });

    return {
      manager,
      server,
      sessionId: result.sessionId,
      port: server.port ?? port,
    };
  } catch (err) {
    await manager.stop().catch(() => {});
    server.close();
    throw err;
  }
}
