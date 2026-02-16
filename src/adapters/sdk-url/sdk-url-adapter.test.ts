import { describe, expect, it } from "vitest";
import { SdkUrlAdapter } from "./sdk-url-adapter.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SdkUrlAdapter", () => {
  const adapter = new SdkUrlAdapter();

  // -----------------------------------------------------------------------
  // name
  // -----------------------------------------------------------------------

  describe("name", () => {
    it("is 'sdk-url'", () => {
      expect(adapter.name).toBe("sdk-url");
    });
  });

  // -----------------------------------------------------------------------
  // capabilities
  // -----------------------------------------------------------------------

  describe("capabilities", () => {
    it("has streaming enabled", () => {
      expect(adapter.capabilities.streaming).toBe(true);
    });

    it("has permissions enabled", () => {
      expect(adapter.capabilities.permissions).toBe(true);
    });

    it("has slashCommands enabled", () => {
      expect(adapter.capabilities.slashCommands).toBe(true);
    });

    it("has availability set to local", () => {
      expect(adapter.capabilities.availability).toBe("local");
    });

    it("has teams enabled", () => {
      expect(adapter.capabilities.teams).toBe(true);
    });

    it("has all expected capability keys", () => {
      expect(adapter.capabilities).toEqual({
        streaming: true,
        permissions: true,
        slashCommands: true,
        availability: "local",
        teams: true,
      });
    });
  });

  // -----------------------------------------------------------------------
  // connect
  // -----------------------------------------------------------------------

  describe("connect", () => {
    it("throws 'not yet implemented' error", async () => {
      await expect(adapter.connect({ sessionId: "test-session" })).rejects.toThrow(
        "SdkUrlAdapter.connect() not yet implemented",
      );
    });

    it("rejects with an Error instance", async () => {
      await expect(adapter.connect({ sessionId: "test-session" })).rejects.toBeInstanceOf(Error);
    });
  });
});
