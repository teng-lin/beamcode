import { describe, expect, it } from "vitest";
import { classifyGeminiError } from "./gemini-error-classifier.js";

describe("classifyGeminiError", () => {
  describe("provider_auth", () => {
    it("classifies 'Verify your account' as provider_auth", () => {
      expect(classifyGeminiError(500, "Verify your account to continue.")).toBe("provider_auth");
    });

    it("classifies HTTP 401 as provider_auth", () => {
      expect(classifyGeminiError(401, "Unauthorized")).toBe("provider_auth");
    });

    it("classifies HTTP 403 as provider_auth", () => {
      expect(classifyGeminiError(403, "Forbidden")).toBe("provider_auth");
    });

    it("classifies authentication message as provider_auth", () => {
      expect(classifyGeminiError(500, "Authentication failed")).toBe("provider_auth");
    });
  });

  describe("rate_limit", () => {
    it("classifies HTTP 429 as rate_limit", () => {
      expect(classifyGeminiError(429, "Too many requests")).toBe("rate_limit");
    });

    it("classifies quota message as rate_limit", () => {
      expect(classifyGeminiError(500, "Quota exceeded for this project")).toBe("rate_limit");
    });

    it("classifies rate limit message as rate_limit", () => {
      expect(classifyGeminiError(500, "Rate limit reached")).toBe("rate_limit");
    });
  });

  describe("context_overflow", () => {
    it("classifies context overflow as context_overflow", () => {
      expect(classifyGeminiError(500, "Context window overflow")).toBe("context_overflow");
    });
  });

  describe("api_error (default)", () => {
    it("defaults to api_error for unknown errors", () => {
      expect(classifyGeminiError(-32603, "Internal error")).toBe("api_error");
    });

    it("defaults to api_error for generic 500", () => {
      expect(classifyGeminiError(500, "Something went wrong")).toBe("api_error");
    });
  });
});
