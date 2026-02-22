import type { Logger } from "../../interfaces/logger.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import type { Session, SessionRepository } from "../session-repository.js";

export interface SessionPersistenceServiceOptions {
  store: SessionRepository;
  logger: Logger;
}

export class SessionPersistenceService {
  private readonly store: SessionRepository;
  private readonly logger: Logger;

  constructor(options: SessionPersistenceServiceOptions) {
    this.store = options.store;
    this.logger = options.logger;
  }

  restoreFromStorage(): number {
    const count = this.store.restoreAll();
    if (count > 0) {
      this.logger.info(`Restored ${count} session(s) from disk`);
    }
    return count;
  }

  persist(session: Session): void {
    this.store.persist(session);
  }

  getStorage(): SessionStorage | null {
    return this.store.getStorage();
  }
}
