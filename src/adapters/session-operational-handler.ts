import type { BridgeOperations, OperationalHandler } from "../interfaces/operational-handler.js";
import type {
  ListSessionsResponse,
  OperationalCommand,
  OperationalResponse,
} from "../types/operational-commands.js";

/**
 * Operational handler for session management.
 * Implements privileged operations: list sessions, close sessions, archive sessions, etc.
 * Requires authorization - typically used only for admin/operator endpoints.
 */
export class SessionOperationalHandler implements OperationalHandler {
  constructor(private bridge: BridgeOperations) {}

  async handle(command: OperationalCommand): Promise<OperationalResponse> {
    switch (command.type) {
      case "list_sessions":
        return this.listSessions();

      case "get_session_stats":
        return this.getSessionStats(command.sessionId);

      case "close_session":
        return this.closeSession(command.sessionId, command.reason);

      case "archive_session":
        return this.archiveSession(command.sessionId);

      case "unarchive_session":
        return this.unarchiveSession(command.sessionId);

      case "get_health":
        return this.getHealth();

      default:
        throw new Error(
          `Unknown command type: ${String((command as OperationalCommand & { type: unknown }).type)}`,
        );
    }
  }

  private listSessions(): ListSessionsResponse[] {
    try {
      const sessionStates = this.bridge.getAllSessions();
      if (!sessionStates) return [];

      return sessionStates.map((session) => {
        const snapshot = this.bridge.getSession(session.session_id);
        return {
          sessionId: session.session_id,
          cliConnected: this.bridge.isCliConnected(session.session_id),
          consumerCount: snapshot?.consumerCount ?? 0,
          messageCount: snapshot?.messageHistoryLength ?? 0,
          uptime: 0,
          lastActivity: Date.now(),
        };
      });
    } catch {
      return [];
    }
  }

  private getSessionStats(sessionId: string) {
    const session = this.bridge.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return {
      sessionId,
      consumers: session.consumerCount ?? 0,
      messageCount: session.messageHistoryLength ?? 0,
      uptime: 0,
      lastActivity: Date.now(),
      cliConnected: session.cliConnected ?? false,
      pendingPermissions: (session.pendingPermissions ?? []).length,
      queuedMessages: 0,
    };
  }

  private async closeSession(sessionId: string, reason?: string) {
    try {
      await this.bridge.closeSession(sessionId);
      return {
        success: true,
        sessionId,
        message: reason ? `Closed: ${reason}` : "Session closed by operator",
      };
    } catch (err) {
      return {
        success: false,
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private archiveSession(sessionId: string) {
    try {
      const session = this.bridge.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          sessionId,
          message: "Session not found",
        };
      }

      // Archive in storage
      const storage = this.bridge.storage;
      if (storage?.setArchived) {
        storage.setArchived(sessionId, true);
      }

      return {
        success: true,
        sessionId,
        message: "Session archived",
      };
    } catch (err) {
      return {
        success: false,
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private unarchiveSession(sessionId: string) {
    try {
      const storage = this.bridge.storage;
      if (!storage?.setArchived) {
        return {
          success: false,
          sessionId,
          message: "Storage does not support archive operations",
        };
      }

      storage.setArchived(sessionId, false);

      return {
        success: true,
        sessionId,
        message: "Session unarchived",
      };
    } catch (err) {
      return {
        success: false,
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getHealth() {
    try {
      const sessions = this.bridge.getAllSessions();
      const connectedCLIs = sessions.filter((s) => this.bridge.isCliConnected(s.session_id)).length;

      const totalConsumers = sessions.reduce((sum: number, s) => {
        const snapshot = this.bridge.getSession(s.session_id);
        return sum + (snapshot?.consumerCount ?? 0);
      }, 0);

      // Determine overall health
      const status: "ok" | "degraded" = sessions.length > 0 ? "ok" : "degraded";

      return {
        status,
        activeSessions: sessions.length,
        cliConnected: connectedCLIs,
        consumerConnections: totalConsumers,
        uptime: process.uptime() * 1000, // Convert to milliseconds
        timestamp: new Date().toISOString(),
      };
    } catch (_err) {
      return {
        status: "error" as const,
        activeSessions: 0,
        cliConnected: 0,
        consumerConnections: 0,
        uptime: process.uptime() * 1000,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
