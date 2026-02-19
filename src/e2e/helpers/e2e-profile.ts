export type E2EProfile = "deterministic" | "real-smoke" | "real-full";

function normalizeProfile(value: string | undefined): E2EProfile {
  // Accept both new (real-*) and legacy (realcli-*) names
  if (value === "real-smoke" || value === "realcli-smoke") {
    return "real-smoke";
  }
  if (value === "real-full" || value === "realcli-full") {
    return "real-full";
  }
  return "deterministic";
}

export function getE2EProfile(): E2EProfile {
  return normalizeProfile(process.env.E2E_PROFILE);
}

export function isRealCliProfile(profile = getE2EProfile()): boolean {
  return profile === "real-smoke" || profile === "real-full";
}

/**
 * Returns true if the given backend's real e2e tests should run,
 * based on binary availability and the current profile.
 */
export function shouldRunBackend(
  backend: string,
  prereqOk: boolean,
  canBindLocalhost: boolean,
): boolean {
  return prereqOk && canBindLocalhost && isRealCliProfile();
}
