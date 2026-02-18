/**
 * CodexSlashExecutor — translates slash commands into Codex JSON-RPC calls.
 *
 * Lives in adapters/codex/ to keep the dependency direction correct.
 * The core/ layer accesses it via the duck-typed `adapterSlashExecutor`
 * field on Session, never importing this module directly.
 */

import type { CodexSession, JsonRpcResponse } from "./codex-session.js";

export interface CodexSlashResult {
  content: string;
  source: "emulated";
  durationMs: number;
}

const CODEX_SLASH_COMMANDS = new Map<string, string>([
  ["/compact", "thread/compact/start"],
  ["/new", "thread/start"],
  ["/review", "review/start"],
  ["/rename", "thread/name/set"],
]);

export class CodexSlashExecutor {
  constructor(private session: CodexSession) {}

  /** Returns list of supported command names (for populating slash_commands). */
  supportedCommands(): string[] {
    return [...CODEX_SLASH_COMMANDS.keys()];
  }

  /** Returns true if this executor handles the given command. */
  handles(command: string): boolean {
    const name = command.trim().split(/\s+/)[0];
    return CODEX_SLASH_COMMANDS.has(name);
  }

  /** Execute a slash command via Codex JSON-RPC. Returns null if not handled. */
  async execute(command: string): Promise<CodexSlashResult | null> {
    const parts = command.trim().split(/\s+/);
    const name = parts[0];
    const args = parts.slice(1).join(" ");

    if (!CODEX_SLASH_COMMANDS.has(name)) return null;

    const start = Date.now();
    const threadId = this.session.currentThreadId;

    try {
      let content: string;

      switch (name) {
        case "/compact": {
          this.requireThread(threadId);
          const resp = await this.session.requestRpc("thread/compact/start", { threadId }, 60_000);
          content = this.formatResponse(resp, "Compaction started.");
          break;
        }
        case "/new": {
          const newThreadId = await this.session.resetThread();
          content = `New thread started: ${newThreadId}`;
          break;
        }
        case "/review": {
          this.requireThread(threadId);
          const resp = await this.session.requestRpc("review/start", { threadId });
          content = this.formatResponse(resp, "Review started.");
          break;
        }
        case "/rename": {
          this.requireThread(threadId);
          if (!args) throw new Error("Usage: /rename <name>");
          await this.session.requestRpc("thread/name/set", { threadId, name: args });
          content = `Thread renamed to: ${args}`;
          break;
        }
        default:
          return null;
      }

      return { content, source: "emulated", durationMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("-32601") || message.includes("method not found")) {
        throw new Error(
          `Codex server does not support "${CODEX_SLASH_COMMANDS.get(name)}". ` +
            `This may require a newer version of the Codex CLI.`,
        );
      }
      throw err;
    }
  }

  private requireThread(threadId: string | null): asserts threadId is string {
    if (!threadId) throw new Error("No active thread. Send a message first.");
  }

  private formatResponse(resp: JsonRpcResponse, fallback: string): string {
    if (resp.error) return `Error: ${resp.error.message}`;
    return fallback;
  }
}
