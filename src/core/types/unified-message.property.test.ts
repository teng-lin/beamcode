import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  createUnifiedMessage,
  isCodeContent,
  isImageContent,
  isTextContent,
  isToolResultContent,
  isToolUseContent,
  isUnifiedMessage,
  type UnifiedContent,
  type UnifiedMessage,
  type UnifiedMessageType,
  type UnifiedRole,
} from "./unified-message.js";

const MESSAGE_TYPES: UnifiedMessageType[] = [
  "session_init",
  "status_change",
  "assistant",
  "result",
  "stream_event",
  "permission_request",
  "control_response",
  "tool_progress",
  "tool_use_summary",
  "auth_status",
  "user_message",
  "permission_response",
  "interrupt",
  "configuration_change",
  "team_message",
  "team_task_update",
  "team_state_change",
  "unknown",
];

const ROLES: UnifiedRole[] = ["user", "assistant", "system", "tool"];

const arbMessageType = fc.constantFrom(...MESSAGE_TYPES);
const arbRole = fc.constantFrom(...ROLES);

const arbTextContent: fc.Arbitrary<UnifiedContent> = fc.record({
  type: fc.constant("text" as const),
  text: fc.string(),
});

const arbToolUseContent: fc.Arbitrary<UnifiedContent> = fc.record({
  type: fc.constant("tool_use" as const),
  id: fc.uuid(),
  name: fc.string({ minLength: 1 }),
  input: fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()),
});

const arbToolResultContent: fc.Arbitrary<UnifiedContent> = fc.record({
  type: fc.constant("tool_result" as const),
  tool_use_id: fc.uuid(),
  content: fc.string(),
  is_error: fc.option(fc.boolean(), { nil: undefined }),
});

const arbCodeContent: fc.Arbitrary<UnifiedContent> = fc.record({
  type: fc.constant("code" as const),
  language: fc.string({ minLength: 1 }),
  code: fc.string(),
});

const arbContent = fc.oneof(
  arbTextContent,
  arbToolUseContent,
  arbToolResultContent,
  arbCodeContent,
);

const arbMetadata = fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue());

describe("UnifiedMessage property tests", () => {
  it("createUnifiedMessage always produces a valid UnifiedMessage", () => {
    fc.assert(
      fc.property(
        arbMessageType,
        arbRole,
        fc.array(arbContent, { maxLength: 5 }),
        arbMetadata,
        fc.option(fc.uuid(), { nil: undefined }),
        (type, role, content, metadata, parentId) => {
          const msg = createUnifiedMessage({ type, role, content, metadata, parentId });
          expect(isUnifiedMessage(msg)).toBe(true);
        },
      ),
    );
  });

  it("each generated message has a unique ID", () => {
    const ids = new Set<string>();
    fc.assert(
      fc.property(arbMessageType, arbRole, (type, role) => {
        const msg = createUnifiedMessage({ type, role });
        expect(ids.has(msg.id)).toBe(false);
        ids.add(msg.id);
      }),
      { numRuns: 500 },
    );
  });

  it("content type guards are mutually exclusive", () => {
    fc.assert(
      fc.property(arbContent, (block) => {
        const guards = [
          isTextContent(block),
          isToolUseContent(block),
          isToolResultContent(block),
          isCodeContent(block),
          isImageContent(block),
        ];
        expect(guards.filter(Boolean).length).toBe(1);
      }),
    );
  });

  it("isUnifiedMessage rejects non-objects", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), (value) => {
        expect(isUnifiedMessage(value)).toBe(false);
      }),
    );
  });
});

describe("canonicalize property tests", () => {
  it("is deterministic — same input always produces same output", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonicalize(value)).toBe(canonicalize(value));
      }),
    );
  });

  it("object key order does not affect output", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1 }).filter((s) => s !== "__proto__"),
          fc.jsonValue(),
          { minKeys: 2, maxKeys: 10 },
        ),
        (obj) => {
          const keys = Object.keys(obj);
          const reversed: Record<string, unknown> = {};
          for (const key of [...keys].reverse()) reversed[key] = obj[key];
          expect(canonicalize(reversed)).toBe(canonicalize(obj));
        },
      ),
    );
  });

  it("output is valid JSON for any JSON-compatible input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const canonical = canonicalize(value);
        expect(() => JSON.parse(canonical)).not.toThrow();
      }),
    );
  });

  it("roundtrip: JSON.parse(canonicalize(v)) deep-equals the original", () => {
    // Normalize through JSON to ensure values are JSON-stable (e.g. -0 → 0)
    const arbJsonStable = fc.jsonValue().map((v) => JSON.parse(JSON.stringify(v)));
    fc.assert(
      fc.property(arbJsonStable, (value) => {
        const parsed = JSON.parse(canonicalize(value));
        expect(parsed).toEqual(value);
      }),
    );
  });
});
