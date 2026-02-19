import { describe, expect, it } from "vitest";
import { diffObjects } from "./trace-differ.js";

describe("diffObjects", () => {
  it("detects added fields", () => {
    const from = { type: "user_message" };
    const to = { type: "user_message", role: "user", id: "abc" };
    const diffs = diffObjects(from, to);
    expect(diffs).toContain('+role: "user"');
    expect(diffs).toContain('+id: "abc"');
  });

  it("detects removed fields", () => {
    const from = { type: "user_message", session_id: "s1" };
    const to = { type: "user_message" };
    const diffs = diffObjects(from, to);
    expect(diffs).toContain("-session_id");
  });

  it("detects renamed fields (same value, different key)", () => {
    const from = { session_id: "s1", type: "user_message" };
    const to = { metadata: { session_id: "s1" }, type: "user_message" };
    const diffs = diffObjects(from, to);
    expect(diffs.some((d) => d.includes("→") && d.includes("session_id"))).toBe(true);
  });

  it("detects changed values", () => {
    const from = { type: "set_model" };
    const to = { type: "configuration_change" };
    const diffs = diffObjects(from, to);
    expect(diffs).toContain('type: "set_model" → "configuration_change"');
  });

  it("detects type changes", () => {
    const from = { content: "hello" };
    const to = { content: ["hello"] };
    const diffs = diffObjects(from, to);
    expect(diffs).toContain("content: string → array");
  });

  it("returns empty diff for identical objects", () => {
    const obj = { type: "user_message", content: "hello" };
    expect(diffObjects(obj, obj)).toEqual([]);
  });

  it("handles null/undefined inputs", () => {
    expect(diffObjects(null, null)).toEqual([]);
    expect(diffObjects(undefined, { a: 1 })).toEqual(["+a: 1"]);
    expect(diffObjects({ a: 1 }, null)).toEqual(["-a"]);
  });

  it("handles nested objects", () => {
    const from = { metadata: { model: "claude" } };
    const to = { metadata: { model: "gpt-4" } };
    const diffs = diffObjects(from, to);
    expect(diffs).toContain('metadata.model: "claude" → "gpt-4"');
  });

  it("truncates long string values", () => {
    const longStr = "x".repeat(100);
    const diffs = diffObjects({}, { field: longStr });
    expect(diffs[0]).toContain("...");
  });

  it("handles primitive inputs at root level", () => {
    expect(diffObjects("hello", "world")).toEqual(['(root): "hello" → "world"']);
    expect(diffObjects(42, 99)).toEqual(["(root): 42 → 99"]);
    expect(diffObjects(true, false)).toEqual(["(root): true → false"]);
  });

  it("handles array inputs as single entries", () => {
    const from = { items: [1, 2, 3] };
    const to = { items: [1, 2, 3, 4] };
    const diffs = diffObjects(from, to);
    // Arrays are not expanded — they show as type change or value change
    expect(diffs.length).toBeGreaterThan(0);
  });

  it("handles empty objects", () => {
    expect(diffObjects({}, {})).toEqual([]);
    expect(diffObjects({}, { a: 1 })).toEqual(["+a: 1"]);
    expect(diffObjects({ a: 1 }, {})).toEqual(["-a"]);
  });

  it("formats null and undefined values", () => {
    const diffs = diffObjects({}, { a: null, b: undefined });
    expect(diffs).toContain("+a: null");
  });

  it("formats arrays as counts, flattens objects", () => {
    const diffs = diffObjects({}, { arr: [1, 2, 3], obj: { x: 1, y: 2 } });
    expect(diffs.some((d) => d.includes("[3 items]"))).toBe(true);
    // Nested objects are flattened, not shown as {N keys}
    expect(diffs.some((d) => d.includes("obj.x"))).toBe(true);
    expect(diffs.some((d) => d.includes("obj.y"))).toBe(true);
  });

  it("handles rename detection with no false positives", () => {
    // Both paths exist in both maps — no rename
    const from = { a: "val", b: "val" };
    const to = { a: "val", b: "val" };
    expect(diffObjects(from, to)).toEqual([]);
  });

  it("handles multiple candidates for rename correctly", () => {
    // Two fields with same value removed, two new fields with same value added
    const from = { old1: "dup", old2: "dup" };
    const to = { new1: "dup", new2: "dup" };
    const diffs = diffObjects(from, to);
    // Should have exactly 2 renames (not 4)
    const renames = diffs.filter((d) => d.includes("→") && !d.includes(":"));
    expect(renames).toHaveLength(2);
  });
});
