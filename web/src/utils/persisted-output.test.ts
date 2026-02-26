import { describe, expect, it } from "vitest";
import { isPersistedOutput, parsePersistedOutput } from "./persisted-output";

const SAMPLE = `<persisted-output>
Output too large (57.8KB). Full output saved to: /tmp/output.txt

Preview (first 2KB):
line 1 of preview
line 2 of preview
...
</persisted-output>`;

describe("isPersistedOutput", () => {
  it("returns true for persisted-output wrapper", () => {
    expect(isPersistedOutput(SAMPLE)).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isPersistedOutput("just some output")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPersistedOutput("")).toBe(false);
  });
});

describe("parsePersistedOutput", () => {
  it("extracts size, filePath, and preview", () => {
    const result = parsePersistedOutput(SAMPLE);
    expect(result).not.toBeNull();
    expect(result!.size).toBe("57.8KB");
    expect(result!.filePath).toBe("/tmp/output.txt");
    expect(result!.preview).toContain("line 1 of preview");
    expect(result!.preview).toContain("line 2 of preview");
  });

  it("returns null for non-matching text", () => {
    expect(parsePersistedOutput("regular output")).toBeNull();
  });
});
