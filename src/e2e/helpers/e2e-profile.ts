/**
 * E2E test profile resolution.
 *
 * Tests run in one of three profiles controlled by the `E2E_PROFILE` env var:
 * - `"mock"` — default; uses MockProcessManager, no real CLI needed
 * - `"real-smoke"` — lightweight subset against a real CLI binary
 * - `"real-full"` — full test suite against a real CLI binary
 * @module
 */

/** The active E2E test profile. */
export type E2EProfile = "mock" | "real-smoke" | "real-full";

function normalizeProfile(value: string | undefined): E2EProfile {
  if (value === "real-smoke") return "real-smoke";
  if (value === "real-full") return "real-full";
  return "mock";
}

/** Read the E2E profile from the `E2E_PROFILE` environment variable. */
export function getE2EProfile(): E2EProfile {
  return normalizeProfile(process.env.E2E_PROFILE);
}

/** True when the profile targets a real CLI binary (smoke or full). */
export function isRealCliProfile(profile = getE2EProfile()): boolean {
  return profile === "real-smoke" || profile === "real-full";
}
