import { createRequire } from "node:module";

/**
 * Walk a list of relative `package.json` candidate paths
 * and return the first `.version` string found.
 *
 * @param importMetaUrl  `import.meta.url` of the calling module — used as
 *                       the base for `createRequire`.
 * @param candidates     Relative paths to `package.json` files to try.
 */
export function resolvePackageVersion(importMetaUrl: string, candidates: string[]): string {
  const req = createRequire(importMetaUrl);
  for (const candidate of candidates) {
    try {
      const pkg = req(candidate) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // Try next path candidate.
    }
  }
  return "unknown";
}
