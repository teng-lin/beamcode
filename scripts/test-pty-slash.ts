/**
 * Integration test: verify PtyCommandRunner can scrape /usage from a real Claude CLI session.
 *
 * Usage: CLAUDECODE= npx tsx scripts/test-pty-slash.ts
 */
import * as pty from "node-pty";
import { stripAnsi } from "../src/utils/ansi-strip.js";

function hasTrustPrompt(stripped: string): boolean {
  return stripped.includes("Is this a project you created or one you trust");
}

async function createSession(): Promise<string> {
  console.log("--- Step 1: Creating a Claude session with a quick prompt...");

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = pty.spawn("claude", ["-p", "say hello in 3 words", "--output-format", "json"], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: env as Record<string, string>,
    });

    let output = "";
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Timed out creating session"));
    }, 30000);

    proc.onData((data: string) => {
      output += data;
    });

    proc.onExit(() => {
      clearTimeout(timeout);
      const clean = stripAnsi(output).trim();
      const lines = clean.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.session_id) {
              console.log("  Session ID:", parsed.session_id);
              resolve(parsed.session_id);
              return;
            }
          } catch {
            // continue
          }
        }
      }
      reject(new Error(`Could not find session_id in output: ${clean.substring(0, 300)}`));
    });
  });
}

async function runSlashCommand(sessionId: string, command: string): Promise<string> {
  console.log(`\n--- Step 2: Running "${command}" on session ${sessionId}...`);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = pty.spawn("claude", ["--resume", sessionId], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: env as Record<string, string>,
    });

    let allOutput = "";
    let commandOutput = "";
    let phase: "startup" | "waiting-for-ready" | "command-sent" = "startup";
    let trustHandled = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const startTime = Date.now();

    const hardTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        const clean = stripAnsi(commandOutput).trim();
        if (clean) {
          resolve(clean);
        } else {
          console.log(`  [DEBUG] Hard timeout. allOutput length: ${stripAnsi(allOutput).length}`);
          reject(new Error("Timed out with no command output"));
        }
      }
    }, 60000);

    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (readyTimer) clearTimeout(readyTimer);
      proc.kill();
      resolve(output);
    };

    const resetReadyTimer = () => {
      if (readyTimer) clearTimeout(readyTimer);
      // Wait for 3s of silence after startup to consider the TUI ready
      readyTimer = setTimeout(() => {
        if (phase !== "startup" || settled) return;
        phase = "waiting-for-ready";
        const elapsed = Date.now() - startTime;
        console.log(`  [ACTION] TUI appears ready (3s silence) at +${elapsed}ms`);
        console.log(`  [ACTION] Typing "${command}" then Enter after 300ms`);
        // Type the command
        proc.write(command);
        // Wait for autocomplete to process, then press Enter
        setTimeout(() => {
          if (!settled) {
            phase = "command-sent";
            allOutput = "";
            console.log(`  [ACTION] Pressing Enter to execute command`);
            proc.write("\r");
          }
        }, 300);
      }, 3000);
    };

    const resetSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.log(`  [DEBUG] Command output silence (5s) at +${elapsed}ms`);
        const stripped = stripAnsi(commandOutput).trim();
        const lines = stripped.split("\n");
        const responseLines = lines.filter((l) => l.trim() !== command.trim() && l.trim() !== ">");
        finish(responseLines.join("\n").trim());
      }, 5000);
    };

    proc.onData((data: string) => {
      const elapsed = Date.now() - startTime;
      const cleanData = stripAnsi(data);
      allOutput += data;

      if (cleanData.trim()) {
        const preview = cleanData.substring(0, 120).replace(/\r?\n/g, "\\n");
        console.log(`  [CHUNK +${elapsed}ms] ${JSON.stringify(preview)}`);
      }

      if (phase === "startup") {
        const stripped = stripAnsi(allOutput);

        // Handle trust prompt with delayed Enter
        if (!trustHandled && hasTrustPrompt(stripped)) {
          trustHandled = true;
          console.log(`  [ACTION] Trust prompt detected, sending Enter after 500ms`);
          setTimeout(() => {
            if (!settled && phase === "startup") {
              proc.write("\r");
            }
          }, 500);
          return;
        }

        // Reset the ready timer on each data chunk
        resetReadyTimer();
        return;
      }

      if (phase === "command-sent") {
        commandOutput += data;
        resetSilence();
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(hardTimeout);
      if (!settled) {
        settled = true;
        const clean = stripAnsi(commandOutput).trim();
        resolve(clean || `(empty output, exit code ${exitCode})`);
      }
    });
  });
}

async function main() {
  try {
    const sessionId = await createSession();

    const usage = await runSlashCommand(sessionId, "/usage");
    console.log("\n--- /usage Result ---");
    console.log(usage);

    if (usage.length > 10 && !usage.startsWith("(empty")) {
      console.log("\n--- SUCCESS: Scraped /usage output ---");
    } else {
      console.log("\n--- WARNING: Output seems too short or empty ---");
    }
  } catch (err) {
    console.error("\nFailed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
