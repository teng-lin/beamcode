import type { CommandRunner, CommandRunnerResult } from "../interfaces/command-runner.js";
import { stripAnsi } from "../utils/ansi-strip.js";

interface IPty {
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  kill: (signal?: string) => void;
  pid: number;
}

interface NodePtyModule {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => IPty;
}

/** How long to wait for TUI startup silence before considering it ready */
const TUI_READY_SILENCE_MS = 3000;
/** Delay between typing the command and pressing Enter */
const COMMAND_ENTER_DELAY_MS = 300;
/** Delay before responding to trust/confirmation prompts */
const PROMPT_RESPONSE_DELAY_MS = 500;

/**
 * Detects Claude CLI's workspace trust confirmation prompt.
 */
function hasTrustPrompt(stripped: string): boolean {
  return stripped.includes("Is this a project you created or one you trust");
}

/**
 * Detects Claude CLI's bypass permissions confirmation prompt.
 */
function hasBypassConfirm(stripped: string): boolean {
  return stripped.includes("Enter to confirm") && stripped.includes("Bypass Permissions");
}

/**
 * Executes slash commands by spawning a PTY that resumes the CLI session
 * and writing the command interactively.
 *
 * The Claude CLI uses a full TUI (terminal UI) in interactive mode, which means:
 * - The "> " prompt is rendered via cursor positioning, not plain text newlines
 * - Slash commands trigger autocomplete dropdowns
 * - Trust/permission prompts may appear before the TUI loads
 *
 * Strategy:
 * 1. Handle any trust/bypass prompts with delayed Enter
 * 2. Wait for TUI readiness via startup silence detection
 * 3. Type the command, wait briefly for autocomplete, then press Enter
 * 4. Capture output via silence threshold or process exit
 */
export class PtyCommandRunner implements CommandRunner {
  private nodePty: NodePtyModule | null = null;

  private async loadNodePty(): Promise<NodePtyModule> {
    if (this.nodePty) return this.nodePty;
    try {
      // Dynamic import — node-pty is an optional peer dependency
      this.nodePty = await (Function('return import("node-pty")')() as Promise<NodePtyModule>);
      return this.nodePty;
    } catch {
      throw new Error(
        "node-pty is required for PTY-based slash commands but is not installed. " +
          "Install it with: npm install node-pty",
      );
    }
  }

  async execute(
    cliSessionId: string,
    command: string,
    options: {
      cwd: string;
      claudeBinary?: string;
      timeoutMs: number;
      silenceThresholdMs: number;
      env?: Record<string, string | undefined>;
    },
  ): Promise<CommandRunnerResult> {
    const pty = await this.loadNodePty();
    const binary = options.claudeBinary ?? "claude";
    const start = Date.now();

    // Build clean env (filter out undefined values)
    const env: Record<string, string> = {};
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v !== undefined) env[k] = v;
      }
    }

    const proc = pty.spawn(binary, ["--resume", cliSessionId], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });

    return new Promise<CommandRunnerResult>((resolve, reject) => {
      let allOutput = "";
      let commandOutput = "";
      // Phases: startup → command-sent
      let phase: "startup" | "command-sent" = "startup";
      let trustPromptHandled = false;
      let readyTimer: ReturnType<typeof setTimeout> | null = null;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const cleanup = () => {
        if (readyTimer) clearTimeout(readyTimer);
        if (silenceTimer) clearTimeout(silenceTimer);
        dataDisposable.dispose();
        exitDisposable.dispose();
        try {
          proc.kill();
        } catch {
          // already exited
        }
      };

      const settle = (result: CommandRunnerResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const settleError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      // Hard timeout
      const hardTimeout = setTimeout(() => {
        settleError(new Error(`PTY command timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);

      /** Reset the TUI readiness timer — fires when startup output stops flowing */
      const resetReadyTimer = () => {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(() => {
          if (phase !== "startup" || settled) return;
          // TUI is ready — type command, then press Enter after a brief delay
          proc.write(command);
          setTimeout(() => {
            if (settled) return;
            phase = "command-sent";
            allOutput = "";
            proc.write("\r");
          }, COMMAND_ENTER_DELAY_MS);
        }, TUI_READY_SILENCE_MS);
      };

      /** Reset the command output silence timer */
      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          clearTimeout(hardTimeout);
          settle({
            output: stripAnsi(commandOutput).trim(),
            rawOutput: commandOutput,
            exitCode: null,
            durationMs: Date.now() - start,
          });
        }, options.silenceThresholdMs);
      };

      const dataDisposable = proc.onData((data: string) => {
        allOutput += data;

        if (phase === "startup") {
          const stripped = stripAnsi(allOutput);

          // Handle trust/bypass confirmation prompts with delayed Enter
          if (!trustPromptHandled && (hasTrustPrompt(stripped) || hasBypassConfirm(stripped))) {
            trustPromptHandled = true;
            setTimeout(() => {
              if (!settled && phase === "startup") {
                proc.write("\r");
              }
            }, PROMPT_RESPONSE_DELAY_MS);
            return;
          }

          // Reset ready timer — TUI is "ready" after data stops flowing
          resetReadyTimer();
          return;
        }

        // command-sent phase — collect output
        commandOutput += data;
        resetSilenceTimer();
      });

      const exitDisposable = proc.onExit((e: { exitCode: number }) => {
        clearTimeout(hardTimeout);
        settle({
          output: stripAnsi(commandOutput).trim(),
          rawOutput: commandOutput,
          exitCode: e.exitCode,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  dispose(): void {
    // No persistent resources to clean up
  }
}
