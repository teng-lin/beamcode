import type { Logger } from "../../interfaces/logger.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../../types/cli-messages.js";
import type { PolicyCommand } from "../interfaces/runtime-commands.js";
import type { Session, SessionRepository } from "../session-repository.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { RuntimeManager } from "./runtime-manager.js";

export interface RuntimeApiOptions {
  store: SessionRepository;
  runtimeManager: RuntimeManager;
  logger: Logger;
}

export class RuntimeApi {
  private readonly store: SessionRepository;
  private readonly runtimeManager: RuntimeManager;
  private readonly logger: Logger;

  constructor(options: RuntimeApiOptions) {
    this.store = options.store;
    this.runtimeManager = options.runtimeManager;
    this.logger = options.logger;
  }

  sendUserMessage(
    sessionId: string,
    content: string,
    options?: {
      sessionIdOverride?: string;
      images?: { media_type: string; data: string }[];
      traceId?: string;
      slashRequestId?: string;
      slashCommand?: string;
    },
  ): void {
    this.withSessionVoid(sessionId, (session) =>
      this.runtime(session).sendUserMessage(content, options),
    );
  }

  sendPermissionResponse(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: {
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      message?: string;
    },
  ): void {
    this.withSessionVoid(sessionId, (session) =>
      this.runtime(session).sendPermissionResponse(requestId, behavior, options),
    );
  }

  sendInterrupt(sessionId: string): void {
    this.withSessionVoid(sessionId, (session) => this.runtime(session).sendInterrupt());
  }

  sendSetModel(sessionId: string, model: string): void {
    this.withSessionVoid(sessionId, (session) => this.runtime(session).sendSetModel(model));
  }

  sendSetPermissionMode(sessionId: string, mode: string): void {
    this.withSessionVoid(sessionId, (session) => this.runtime(session).sendSetPermissionMode(mode));
  }

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.withSession(sessionId, [] as InitializeModel[], (session) =>
      this.runtime(session).getSupportedModels(),
    );
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.withSession(sessionId, [] as InitializeCommand[], (session) =>
      this.runtime(session).getSupportedCommands(),
    );
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.withSession(sessionId, null, (session) => this.runtime(session).getAccountInfo());
  }

  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.withSession(sessionId, null, (session) =>
      this.runtime(session).executeSlashCommand(command),
    );
  }

  applyPolicyCommand(sessionId: string, command: PolicyCommand): void {
    this.withSessionVoid(sessionId, (session) =>
      this.runtime(session).handlePolicyCommand(command),
    );
  }

  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.logger.warn(`No backend session for ${sessionId}, cannot send message`);
      return;
    }
    this.runtime(session).sendToBackend(message);
  }

  private runtime(session: Session) {
    return this.runtimeManager.getOrCreate(session);
  }

  private withSession<T>(sessionId: string, onMissing: T, run: (session: Session) => T): T {
    const session = this.store.get(sessionId);
    if (!session) return onMissing;
    return run(session);
  }

  private withSessionVoid(sessionId: string, run: (session: Session) => void): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    run(session);
  }
}
