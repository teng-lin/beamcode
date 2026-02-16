import { describe, expect, it } from "vitest";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { exportAsJson, exportAsMarkdown } from "./export";

const MESSAGES: ConsumerMessage[] = [
  { type: "user_message", content: "Hello agent", timestamp: 1700000000000 },
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-3-opus",
      content: [{ type: "text", text: "Hi there!" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  },
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg-2",
      type: "message",
      role: "assistant",
      model: "claude-3-opus",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  },
];

describe("exportAsJson", () => {
  it("returns valid JSON string", () => {
    const json = exportAsJson(MESSAGES);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes all messages", () => {
    const json = exportAsJson(MESSAGES);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(3);
  });
});

describe("exportAsMarkdown", () => {
  it("renders user messages with User heading", () => {
    const md = exportAsMarkdown(MESSAGES);
    expect(md).toContain("### User");
    expect(md).toContain("Hello agent");
  });

  it("renders assistant text content", () => {
    const md = exportAsMarkdown(MESSAGES);
    expect(md).toContain("### Assistant");
    expect(md).toContain("Hi there!");
  });

  it("renders tool_use blocks as code fences", () => {
    const md = exportAsMarkdown(MESSAGES);
    expect(md).toContain("**Bash**");
    expect(md).toContain("```json");
  });

  it("skips non-assistant/user message types gracefully", () => {
    const messages: ConsumerMessage[] = [{ type: "error", message: "something broke" }];
    const md = exportAsMarkdown(messages);
    expect(md).toContain("something broke");
  });
});
