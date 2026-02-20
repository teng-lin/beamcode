export type E2EProfile = "deterministic" | "real-smoke" | "real-full";

function normalizeProfile(value: string | undefined): E2EProfile {
  if (value === "real-smoke") return "real-smoke";
  if (value === "real-full") return "real-full";
  return "deterministic";
}

export function getE2EProfile(): E2EProfile {
  return normalizeProfile(process.env.E2E_PROFILE);
}

export function isRealCliProfile(profile = getE2EProfile()): boolean {
  return profile === "real-smoke" || profile === "real-full";
}
