import { providerConfigSchema } from "../config/config-schema.js";

/** Provider configuration with sensible defaults */
export interface ProviderConfig {
  /** Port the WebSocket server listens on (required) */
  port: number;

  // Timeouts
  gitCommandTimeoutMs?: number; // default: 3000
  relaunchGracePeriodMs?: number; // default: 2000
  killGracePeriodMs?: number; // default: 5000
  storageDebounceMs?: number; // default: 150
  reconnectGracePeriodMs?: number; // default: 10000
  resumeFailureThresholdMs?: number; // default: 5000
  relaunchDedupMs?: number; // default: 5000
  authTimeoutMs?: number; // default: 10000
  initializeTimeoutMs?: number; // default: 5000

  // Resource limits
  maxMessageHistoryLength?: number; // default: 1000
  maxConcurrentSessions?: number; // default: 50
  idleSessionTimeoutMs?: number; // default: 0 (disabled)
  pendingMessageQueueMaxSize?: number; // default: 100

  // Rate limiting
  consumerMessageRateLimit?: {
    tokensPerSecond: number; // default: 50 tokens/sec
    burstSize: number; // default: 100 (max tokens to accumulate)
  };

  // Circuit breaker for CLI restart
  cliRestartCircuitBreaker?: {
    failureThreshold: number; // default: 5 crashes
    windowMs: number; // default: 60000 (1 minute)
    recoveryTimeMs: number; // default: 30000 (30 seconds)
    successThreshold: number; // default: 2 successful restarts to recover
  };

  // CLI
  defaultClaudeBinary?: string; // default: "claude"
  cliWebSocketUrlTemplate?: (sessionId: string) => string;

  // Slash command execution
  slashCommand?: {
    ptyTimeoutMs: number; // default: 30000
    ptySilenceThresholdMs: number; // default: 3000
    ptyEnabled: boolean; // default: true
  };

  // Security
  envDenyList?: string[];
}

/** Fully resolved configuration with defaults applied. */
export type ResolvedConfig = Required<
  Omit<
    ProviderConfig,
    | "cliWebSocketUrlTemplate"
    | "envDenyList"
    | "consumerMessageRateLimit"
    | "cliRestartCircuitBreaker"
    | "slashCommand"
  >
> &
  Pick<ProviderConfig, "cliWebSocketUrlTemplate" | "envDenyList"> & {
    consumerMessageRateLimit: Required<NonNullable<ProviderConfig["consumerMessageRateLimit"]>>;
    cliRestartCircuitBreaker: Required<NonNullable<ProviderConfig["cliRestartCircuitBreaker"]>>;
    slashCommand: Required<NonNullable<ProviderConfig["slashCommand"]>>;
  };

export const DEFAULT_CONFIG: ResolvedConfig = {
  port: 9414,
  gitCommandTimeoutMs: 3000,
  relaunchGracePeriodMs: 2000,
  killGracePeriodMs: 5000,
  storageDebounceMs: 150,
  reconnectGracePeriodMs: 10000,
  resumeFailureThresholdMs: 5000,
  relaunchDedupMs: 5000,
  authTimeoutMs: 10000,
  initializeTimeoutMs: 5000,
  maxMessageHistoryLength: 1000,
  maxConcurrentSessions: 50,
  idleSessionTimeoutMs: 0,
  pendingMessageQueueMaxSize: 100,
  consumerMessageRateLimit: {
    tokensPerSecond: 50, // Production-safe default; can be overridden
    burstSize: 20,
  },
  cliRestartCircuitBreaker: {
    failureThreshold: 5,
    windowMs: 60000,
    recoveryTimeMs: 30000,
    successThreshold: 2,
  },
  defaultClaudeBinary: "claude",
  cliWebSocketUrlTemplate: undefined,
  envDenyList: ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"],
  slashCommand: {
    ptyTimeoutMs: 30000,
    ptySilenceThresholdMs: 3000,
    ptyEnabled: true,
  },
};

/** Deep merge objects, with user config taking precedence over defaults. */
function deepMerge<T extends Record<string, unknown>>(defaults: T, userConfig?: Partial<T>): T {
  if (!userConfig) return defaults;

  const result = { ...defaults };
  for (const key in userConfig) {
    const userValue = userConfig[key];
    const defaultValue = defaults[key];

    // Recursively merge nested objects
    if (
      userValue &&
      typeof userValue === "object" &&
      !Array.isArray(userValue) &&
      defaultValue &&
      typeof defaultValue === "object" &&
      !Array.isArray(defaultValue)
    ) {
      result[key] = deepMerge(
        defaultValue as Record<string, unknown>,
        userValue as Record<string, unknown>,
      ) as T[Extract<keyof T, string>];
    } else {
      result[key] = userValue as T[Extract<keyof T, string>];
    }
  }
  return result;
}

export function resolveConfig(config: ProviderConfig): ResolvedConfig {
  // Validate user-provided config before merging
  const validation = providerConfigSchema.safeParse(config);
  if (!validation.success) {
    throw new Error(`Invalid configuration: ${validation.error.message}`);
  }

  const resolved = deepMerge(DEFAULT_CONFIG, config);
  // Never let user config erase the security deny list (S6 hardening)
  if (!resolved.envDenyList || resolved.envDenyList.length === 0) {
    resolved.envDenyList = DEFAULT_CONFIG.envDenyList;
  }
  return resolved;
}
