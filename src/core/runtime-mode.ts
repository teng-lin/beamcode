/**
 * RuntimeMode — core runtime mode flag for phased architecture migration.
 *
 * Controls which runtime path SessionBridge uses: `legacy` (current production)
 * or `vnext_shadow` (shadow mode that runs SessionRuntimeShadow in parallel
 * for parity validation).
 *
 * @module SessionControl
 */

export const CORE_RUNTIME_MODES = ["legacy", "vnext_shadow"] as const;

export type CoreRuntimeMode = (typeof CORE_RUNTIME_MODES)[number];

export const DEFAULT_CORE_RUNTIME_MODE: CoreRuntimeMode = "legacy";

export function isCoreRuntimeMode(value: string): value is CoreRuntimeMode {
  return (CORE_RUNTIME_MODES as readonly string[]).includes(value);
}

export function resolveCoreRuntimeMode(value: string | undefined): CoreRuntimeMode {
  if (!value) return DEFAULT_CORE_RUNTIME_MODE;
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (!isCoreRuntimeMode(normalized)) {
    throw new Error(
      `Invalid core runtime mode "${value}". Expected one of: ${CORE_RUNTIME_MODES.join(", ")}`,
    );
  }
  return normalized;
}
