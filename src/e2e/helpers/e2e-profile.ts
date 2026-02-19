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
