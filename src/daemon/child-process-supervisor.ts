import { randomUUID } from "node:crypto";
import type { ProcessSupervisorOptions } from "../core/process-supervisor.js";
import { ProcessSupervisor } from "../core/process-supervisor.js";
import type { Logger } from "../interfaces/logger.js";
import type { ProcessManager } from "../interfaces/process-manager.js";

export interface DaemonSessionInfo {
  sessionId: string;
  pid?: number;
  status: "running" | "stopped";
  createdAt: number;
  cwd: string;
  model?: string;
  permissionMode?: string;
}

export interface CreateSessionOptions {
  cwd: string;
  model?: string;
  permissionMode?: string;
  claudeBinary?: string;
}

interface SpawnPayload {
  command: string;
  args: string[];
  cwd: string;
}

const DEFAULT_MAX_SESSIONS = 50;

/**
 * A simplified child-process supervisor for the daemon.
 * Manages CLI sessions as child processes, tracking their metadata in memory.
 */
export class ChildProcessSupervisor extends ProcessSupervisor {
  private sessions = new Map<string, DaemonSessionInfo>();
  private defaultBinary: string;
  private maxSessions: number;

  constructor(options: {
    processManager: ProcessManager;
    logger?: Logger;
    defaultBinary?: string;
    maxSessions?: number;
  }) {
    const supervisorOptions: ProcessSupervisorOptions = {
      processManager: options.processManager,
      logger: options.logger,
    };
    super(supervisorOptions);
    this.defaultBinary = options.defaultBinary ?? "claude";
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  protected buildSpawnArgs(
    _sessionId: string,
    options: unknown,
  ): { command: string; args: string[]; cwd: string } {
    const payload = options as SpawnPayload;
    return {
      command: payload.command,
      args: payload.args,
      cwd: payload.cwd,
    };
  }

  protected override onProcessExited(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "stopped";
    }
  }

  createSession(options: CreateSessionOptions): DaemonSessionInfo {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum session limit reached (${this.maxSessions})`);
    }

    const sessionId = randomUUID();
    const binary = options.claudeBinary ?? this.defaultBinary;

    const args: string[] = ["--print", "--output-format", "stream-json"];
    if (options.model) args.push("--model", options.model);
    if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
    args.push("-p", "");

    const info: DaemonSessionInfo = {
      sessionId,
      status: "running",
      createdAt: Date.now(),
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
    };

    this.sessions.set(sessionId, info);

    const proc = this.spawnProcess(sessionId, {
      command: binary,
      args,
      cwd: options.cwd,
    } satisfies SpawnPayload);

    if (proc) {
      info.pid = proc.pid;
    } else {
      info.status = "stopped";
    }

    return info;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const killed = await this.killProcess(sessionId);
    session.status = "stopped";
    return killed;
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stopSession(id)));
  }

  listSessions(): DaemonSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): DaemonSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.removeProcess(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
