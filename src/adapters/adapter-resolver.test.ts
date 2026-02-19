import { describe, expect, it, vi } from "vitest";
import { createAdapterResolver } from "./adapter-resolver.js";

describe("createAdapterResolver", () => {
  const mockDeps = {
    processManager: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  };

  it("resolves claude adapter", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve("claude");
    expect(adapter.name).toBe("claude");
  });

  it("resolves codex adapter", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve("codex");
    expect(adapter.name).toBe("codex");
  });

  it("resolves acp adapter", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve("acp");
    expect(adapter.name).toBe("acp");
  });

  it("uses specified default when name is undefined", () => {
    const resolver = createAdapterResolver(mockDeps, "codex");
    const adapter = resolver.resolve(undefined);
    expect(adapter.name).toBe("codex");
  });

  it("falls back to claude when no default specified", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve(undefined);
    expect(adapter.name).toBe("claude");
  });

  it("returns same ClaudeAdapter instance (singleton)", () => {
    const resolver = createAdapterResolver(mockDeps);
    const a1 = resolver.resolve("claude");
    const a2 = resolver.resolve("claude");
    expect(a1).toBe(a2);
  });

  it("returns fresh Codex instances (not singleton)", () => {
    const resolver = createAdapterResolver(mockDeps);
    const a1 = resolver.resolve("codex");
    const a2 = resolver.resolve("codex");
    expect(a1).not.toBe(a2);
  });

  it("eagerly creates claudeAdapter on construction", () => {
    const resolver = createAdapterResolver(mockDeps);
    // ClaudeAdapter is created eagerly, not lazily
    expect(resolver.claudeAdapter).not.toBeNull();
    expect(resolver.claudeAdapter?.name).toBe("claude");
  });

  it("throws for unknown adapter name", () => {
    const resolver = createAdapterResolver(mockDeps);
    expect(() => resolver.resolve("bogus" as any)).toThrow();
  });

  it("returns available adapter names", () => {
    const resolver = createAdapterResolver(mockDeps);
    expect(resolver.availableAdapters).toEqual(["claude", "codex", "acp", "gemini", "opencode"]);
  });
});
