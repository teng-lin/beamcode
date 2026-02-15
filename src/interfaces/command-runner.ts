export interface CommandRunnerResult {
  output: string;
  rawOutput: string;
  exitCode: number | null;
  durationMs: number;
}

export interface CommandRunner {
  execute(
    cliSessionId: string,
    command: string,
    options: {
      cwd: string;
      claudeBinary?: string;
      timeoutMs: number;
      silenceThresholdMs: number;
      env?: Record<string, string | undefined>;
    },
  ): Promise<CommandRunnerResult>;

  dispose(): void;
}
