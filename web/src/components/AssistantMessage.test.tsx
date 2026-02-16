import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantContent, ConsumerContentBlock } from "../../../shared/consumer-types";
import { AssistantMessage } from "./AssistantMessage";

vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));
vi.mock("./ThinkingBlock", () => ({
  ThinkingBlock: ({ content }: { content: string }) => <div data-testid="thinking">{content}</div>,
}));
vi.mock("./ToolBlock", () => ({
  ToolBlock: ({ name }: { name: string }) => <div data-testid="tool-block">{name}</div>,
}));
vi.mock("./ToolGroupBlock", () => ({
  ToolGroupBlock: ({ blocks }: { blocks: unknown[] }) => (
    <div data-testid="tool-group">{blocks.length} tools</div>
  ),
}));

const SESSION_ID = "test-session";

function makeAssistantContent(
  content: ConsumerContentBlock[],
  overrides?: Partial<AssistantContent>,
): AssistantContent {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    model: "claude-3-opus",
    content,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

describe("AssistantMessage", () => {
  it("renders text blocks via MarkdownContent", () => {
    const message = makeAssistantContent([{ type: "text", text: "Hello markdown" }]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("markdown")).toHaveTextContent("Hello markdown");
  });

  it("renders thinking blocks via ThinkingBlock", () => {
    const message = makeAssistantContent([{ type: "thinking", thinking: "Let me think..." }]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("thinking")).toHaveTextContent("Let me think...");
  });

  it("renders single tool_use via ToolBlock", () => {
    const message = makeAssistantContent([
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
    ]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("tool-block")).toHaveTextContent("Bash");
  });

  it("groups multiple same-name tool_use into ToolGroupBlock", () => {
    const message = makeAssistantContent([
      { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
    ]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("tool-group")).toHaveTextContent("2 tools");
  });

  it("renders tool_result as collapsible details", () => {
    const message = makeAssistantContent([
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "result output",
      },
    ]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText(/Tool result/)).toBeInTheDocument();
    expect(screen.getByText("result output")).toBeInTheDocument();
  });

  it("renders tool_result error state with (error) text", () => {
    const message = makeAssistantContent([
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "something failed",
        is_error: true,
      },
    ]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText(/Tool result/)).toBeInTheDocument();
    expect(screen.getByText(/(error)/)).toBeInTheDocument();
  });

  it("handles empty content array", () => {
    const message = makeAssistantContent([]);
    const { container } = render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    // The wrapper div renders but has no children
    expect(container.firstChild).toBeInTheDocument();
    expect(container.firstChild?.childNodes.length).toBe(0);
  });

  it("does not group different-name tool_use blocks together", () => {
    const message = makeAssistantContent([
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/a.ts" } },
    ]);
    render(<AssistantMessage message={message} sessionId={SESSION_ID} />);
    const toolBlocks = screen.getAllByTestId("tool-block");
    expect(toolBlocks).toHaveLength(2);
    expect(toolBlocks[0]).toHaveTextContent("Bash");
    expect(toolBlocks[1]).toHaveTextContent("Read");
  });
});
