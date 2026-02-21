import { describe, expect, it } from "vitest";
import { AgentSdkAdapter } from "./agent-sdk-adapter.js";

describe("AgentSdkAdapter", () => {
  it("has name 'agent-sdk'", () => {
    const adapter = new AgentSdkAdapter();
    expect(adapter.name).toBe("agent-sdk");
  });

  it("declares correct capabilities", () => {
    const adapter = new AgentSdkAdapter();
    expect(adapter.capabilities).toEqual({
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
      teams: true,
    });
  });

  it("connect() returns a Promise", () => {
    const adapter = new AgentSdkAdapter();
    const result = adapter.connect({ sessionId: "test" });
    expect(result).toBeInstanceOf(Promise);
    // Clean up — the dynamic import will fail in test but that's fine
    result.catch(() => {});
  });

  it("stop() resolves without error", async () => {
    const adapter = new AgentSdkAdapter();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});
