import { describe, expect, it } from "vitest";
import {
  CORE_RUNTIME_MODES,
  DEFAULT_CORE_RUNTIME_MODE,
  isCoreRuntimeMode,
  resolveCoreRuntimeMode,
} from "./runtime-mode.js";

describe("runtime mode", () => {
  it("defaults to legacy when unset", () => {
    expect(resolveCoreRuntimeMode(undefined)).toBe(DEFAULT_CORE_RUNTIME_MODE);
  });

  it("accepts valid values", () => {
    expect(resolveCoreRuntimeMode("legacy")).toBe("legacy");
    expect(resolveCoreRuntimeMode("vnext_shadow")).toBe("vnext_shadow");
    expect(resolveCoreRuntimeMode("vnext-shadow")).toBe("vnext_shadow");
  });

  it("rejects invalid values", () => {
    expect(() => resolveCoreRuntimeMode("unknown")).toThrow(/Invalid core runtime mode/);
  });

  it("recognizes known runtime modes", () => {
    for (const mode of CORE_RUNTIME_MODES) {
      expect(isCoreRuntimeMode(mode)).toBe(true);
    }
    expect(isCoreRuntimeMode("other")).toBe(false);
  });
});
