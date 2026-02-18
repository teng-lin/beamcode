export type E2EProfile = "deterministic" | "realcli-smoke" | "realcli-full";

function normalizeProfile(value: string | undefined): E2EProfile {
  if (value === "realcli-smoke" || value === "realcli-full") {
    return value;
  }
  return "deterministic";
}

export function getE2EProfile(): E2EProfile {
  return normalizeProfile(process.env.E2E_PROFILE);
}

export function isRealCliProfile(profile = getE2EProfile()): boolean {
  return profile === "realcli-smoke" || profile === "realcli-full";
}
