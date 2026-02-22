import type { BackendConnector } from "../backend-connector.js";
import type { CapabilitiesPolicy } from "../capabilities-policy.js";
import type { Session, SessionRepository } from "../session-repository.js";

export interface BackendApiOptions {
  store: SessionRepository;
  backendConnector: BackendConnector;
  capabilitiesPolicy: CapabilitiesPolicy;
  getOrCreateSession: (sessionId: string) => Session;
}

export class BackendApi {
  private readonly store: SessionRepository;
  private readonly backendConnector: BackendConnector;
  private readonly capabilitiesPolicy: CapabilitiesPolicy;
  private readonly getOrCreateSession: (sessionId: string) => Session;

  constructor(options: BackendApiOptions) {
    this.store = options.store;
    this.backendConnector = options.backendConnector;
    this.capabilitiesPolicy = options.capabilitiesPolicy;
    this.getOrCreateSession = options.getOrCreateSession;
  }

  get hasAdapter(): boolean {
    return this.backendConnector.hasAdapter;
  }

  async connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionId);
    return this.backendConnector.connectBackend(session, options);
  }

  async disconnectBackend(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.capabilitiesPolicy.cancelPendingInitialize(session);
    return this.backendConnector.disconnectBackend(session);
  }

  isBackendConnected(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    if (!session) return false;
    return this.backendConnector.isBackendConnected(session);
  }
}
