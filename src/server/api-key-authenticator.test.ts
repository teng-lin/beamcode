import { describe, expect, it } from "vitest";
import type { AuthContext } from "../interfaces/auth.js";
import { ApiKeyAuthenticator } from "./api-key-authenticator.js";

function makeContext(token?: string): AuthContext {
  return {
    sessionId: "test-session",
    transport: {
      headers: {},
      query: token !== undefined ? { token } : {},
      remoteAddress: "127.0.0.1",
    },
  };
}

describe("ApiKeyAuthenticator", () => {
  const API_KEY = "test-api-key-abc123";
  const auth = new ApiKeyAuthenticator(API_KEY);

  it("accepts a valid token from query params", async () => {
    const identity = await auth.authenticate(makeContext(API_KEY));
    expect(identity.role).toBe("participant");
    expect(identity.userId).toBe("api-key-user");
  });

  it("rejects a missing token", async () => {
    await expect(auth.authenticate(makeContext())).rejects.toThrow("missing token");
  });

  it("rejects an invalid token", async () => {
    await expect(auth.authenticate(makeContext("wrong-key"))).rejects.toThrow("invalid token");
  });

  it("uses timing-safe comparison (different length keys don't short-circuit)", async () => {
    await expect(auth.authenticate(makeContext("x"))).rejects.toThrow("invalid token");
    await expect(auth.authenticate(makeContext("x".repeat(1000)))).rejects.toThrow("invalid token");
  });
});
