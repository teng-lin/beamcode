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
});
