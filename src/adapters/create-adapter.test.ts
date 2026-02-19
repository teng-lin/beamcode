import { describe, expect, it, vi } from "vitest";
import type { ProcessManager } from "../interfaces/process-manager.js";
import { createAdapter } from "./create-adapter.js";

const mockProcessManager: ProcessManager = {
  spawn: vi.fn(),
  isAlive: vi.fn(),
};

describe("createAdapter", () => {
  it("returns SdkUrlAdapter for 'sdk-url'", () => {
    const adapter = createAdapter("sdk-url", { processManager: mockProcessManager });
    expect(adapter.name).toBe("sdk-url");
  });

  it("returns CodexAdapter for 'codex'", () => {
    const adapter = createAdapter("codex", { processManager: mockProcessManager });
    expect(adapter.name).toBe("codex");
  });

  it("returns AcpAdapter for 'acp'", () => {
    const adapter = createAdapter("acp", { processManager: mockProcessManager });
    expect(adapter.name).toBe("acp");
  });

  it("returns GeminiAdapter for 'gemini'", () => {
    const adapter = createAdapter("gemini", { processManager: mockProcessManager });
    expect(adapter.name).toBe("gemini");
  });

  it("returns OpencodeAdapter for 'opencode'", () => {
    const adapter = createAdapter("opencode", { processManager: mockProcessManager });
    expect(adapter.name).toBe("opencode");
  });

  it("throws for 'agent-sdk' (requires queryFn)", () => {
    expect(() => createAdapter("agent-sdk", { processManager: mockProcessManager })).toThrow(
      /queryFn/i,
    );
  });

  it("throws for unknown adapter name", () => {
    expect(() => createAdapter("unknown" as any, { processManager: mockProcessManager })).toThrow(
      /unknown adapter/i,
    );
  });

  it("defaults to 'sdk-url' when name is undefined", () => {
    const adapter = createAdapter(undefined, { processManager: mockProcessManager });
    expect(adapter.name).toBe("sdk-url");
  });
});
