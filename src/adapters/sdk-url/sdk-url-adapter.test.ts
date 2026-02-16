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
    it("exposes correct capability values", () => {
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
  });
});
