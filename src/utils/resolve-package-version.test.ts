import { describe, expect, it, vi } from "vitest";

import { resolvePackageVersion } from "./resolve-package-version.js";

// We mock createRequire to control what each candidate path resolves to,
// avoiding filesystem dependencies.
vi.mock("node:module", () => ({
  createRequire: (_url: string) => {
    return (id: string) => {
      const registry = (vi as any).__pkgRegistry as Map<string, unknown> | undefined;
      if (registry?.has(id)) {
        const val = registry.get(id);
        if (val instanceof Error) throw val;
        return val;
      }
      throw new Error(`Cannot find module '${id}'`);
    };
  },
}));

function setPkgRegistry(entries: [string, unknown][]) {
  (vi as any).__pkgRegistry = new Map(entries);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolvePackageVersion", () => {
  it("returns version from the first candidate that resolves", () => {
    setPkgRegistry([["./package.json", { version: "1.2.3" }]]);

    const result = resolvePackageVersion("file:///test", ["./package.json"]);
    expect(result).toBe("1.2.3");
  });

  it("falls through to second candidate when first throws", () => {
    setPkgRegistry([
      // first candidate not registered → throws
      ["../package.json", { version: "2.0.0" }],
    ]);

    const result = resolvePackageVersion("file:///test", [
      "./package.json", // throws (not in registry)
      "../package.json", // resolves
    ]);
    expect(result).toBe("2.0.0");
  });

  it("returns 'unknown' when all candidates fail", () => {
    setPkgRegistry([]);

    const result = resolvePackageVersion("file:///test", ["./package.json", "../package.json"]);
    expect(result).toBe("unknown");
  });

  it("skips candidate when package.json has no version field", () => {
    setPkgRegistry([
      ["./package.json", { name: "no-version" }],
      ["../package.json", { version: "3.0.0" }],
    ]);

    const result = resolvePackageVersion("file:///test", [
      "./package.json", // no version field
      "../package.json", // has version
    ]);
    expect(result).toBe("3.0.0");
  });

  it("skips candidate when version is empty string", () => {
    setPkgRegistry([
      ["./package.json", { version: "" }],
      ["../package.json", { version: "4.0.0" }],
    ]);

    const result = resolvePackageVersion("file:///test", ["./package.json", "../package.json"]);
    expect(result).toBe("4.0.0");
  });

  it("skips candidate when version is not a string", () => {
    setPkgRegistry([
      ["./package.json", { version: 123 }],
      ["../package.json", { version: "5.0.0" }],
    ]);

    const result = resolvePackageVersion("file:///test", ["./package.json", "../package.json"]);
    expect(result).toBe("5.0.0");
  });

  it("returns 'unknown' with empty candidates list", () => {
    setPkgRegistry([]);

    const result = resolvePackageVersion("file:///test", []);
    expect(result).toBe("unknown");
  });
});
