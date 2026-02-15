import type { CommandRunner, CommandRunnerResult } from "../interfaces/command-runner.js";

export class MockCommandRunner implements CommandRunner {
  readonly executeCalls: Array<{ cliSessionId: string; command: string }> = [];
  private results = new Map<string, CommandRunnerResult>();
  private defaultResult: CommandRunnerResult = {
    output: "mock output",
    rawOutput: "mock output",
    exitCode: 0,
    durationMs: 100,
  };
  private _shouldThrow: Error | null = null;

  /** Set the result returned for a specific command. */
  setResult(command: string, result: CommandRunnerResult): void {
    this.results.set(command, result);
  }

  /** Set the default result for commands without specific results. */
  setDefaultResult(result: CommandRunnerResult): void {
    this.defaultResult = result;
  }

  /** Make execute() throw an error. */
  setError(error: Error): void {
    this._shouldThrow = error;
  }

  async execute(
    cliSessionId: string,
    command: string,
    _options: {
      cwd: string;
      claudeBinary?: string;
      timeoutMs: number;
      silenceThresholdMs: number;
      env?: Record<string, string | undefined>;
    },
  ): Promise<CommandRunnerResult> {
    this.executeCalls.push({ cliSessionId, command });

    if (this._shouldThrow) {
      throw this._shouldThrow;
    }

    const name = command.split(/\s+/)[0];
    return this.results.get(name) ?? this.results.get(command) ?? this.defaultResult;
  }

  dispose(): void {
    // no-op
  }

  /** Clear all tracking data. */
  clear(): void {
    this.executeCalls.length = 0;
    this.results.clear();
    this._shouldThrow = null;
  }
}
