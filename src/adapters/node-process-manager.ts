import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";

/**
 * Node.js process manager using child_process.spawn.
 * Requires Node 22+ for Readable.toWeb().
 */
export class NodeProcessManager implements ProcessManager {
  spawn(options: SpawnOptions): ProcessHandle {
    const child = nodeSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (typeof child.pid !== "number") {
      throw new Error(`Failed to spawn process: ${options.command}`);
    }

    const pid = child.pid;

    // Wrap Node Readable streams to web ReadableStream via Readable.toWeb() (Node 22+)
    const stdout = child.stdout
      ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
      : null;
    const stderr = child.stderr
      ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>)
      : null;

    // Fabricate the exited Promise from the "exit" event (M3)
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code, signal) => {
        // null code when killed by signal
        resolve(signal ? null : (code ?? null));
      });
      child.on("error", () => {
        resolve(null);
      });
    });

    return {
      pid,
      exited,
      kill(signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM") {
        try {
          child.kill(signal);
        } catch {
          // Process may already be dead
        }
      },
      stdout,
      stderr,
    };
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
