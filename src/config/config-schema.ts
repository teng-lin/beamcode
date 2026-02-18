import { z } from "zod";

const port = z.number().int().min(0).max(65535);
const positiveMs = z.number().int().positive();

export const providerConfigSchema = z.object({
  port,

  // Timeouts
  gitCommandTimeoutMs: positiveMs.optional(),
  relaunchGracePeriodMs: positiveMs.optional(),
  killGracePeriodMs: positiveMs.optional(),
  storageDebounceMs: positiveMs.optional(),
  reconnectGracePeriodMs: positiveMs.optional(),
  resumeFailureThresholdMs: positiveMs.optional(),
  relaunchDedupMs: positiveMs.optional(),
  authTimeoutMs: positiveMs.optional(),
  initializeTimeoutMs: positiveMs.optional(),

  // Resource limits
  maxMessageHistoryLength: z.number().int().min(1).optional(),
  maxConcurrentSessions: z.number().int().min(1).optional(),
  idleSessionTimeoutMs: z.number().int().min(0).optional(),
  pendingMessageQueueMaxSize: z.number().int().min(1).optional(),

  // Rate limiting
  consumerMessageRateLimit: z
    .object({
      tokensPerSecond: z.number().positive(),
      burstSize: z.number().int().min(1),
    })
    .optional(),

  // Circuit breaker
  cliRestartCircuitBreaker: z
    .object({
      failureThreshold: z.number().int().min(1),
      windowMs: positiveMs,
      recoveryTimeMs: positiveMs,
      successThreshold: z.number().int().min(1),
    })
    .optional(),

  // CLI
  defaultClaudeBinary: z.string().optional(),
  cliWebSocketUrlTemplate: z
    .unknown()
    .refine((v) => v === undefined || typeof v === "function", "must be a function")
    .optional(),

  // Slash commands
  slashCommand: z
    .object({
      ptyTimeoutMs: positiveMs,
      ptySilenceThresholdMs: positiveMs,
      ptyEnabled: z.boolean(),
    })
    .optional(),

  // Security
  envDenyList: z.array(z.string()).optional(),
});
