import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { makeAssistantContent } from "../test/factories";
import { MessageBubble } from "./MessageBubble";

vi.mock("./AssistantMessage", () => ({
  AssistantMessage: () => <div data-testid="assistant-message">mock-assistant</div>,
}));

const SESSION_ID = "test-session";

describe("MessageBubble", () => {
  it("renders user message content", () => {
    const message: ConsumerMessage = {
      type: "user_message",
      content: "Hello, world!",
      timestamp: Date.now(),
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText("Hello, world!")).toBeInTheDocument();
  });

  it("renders error message with error text", () => {
    const message: ConsumerMessage = {
      type: "error",
      message: "Something went wrong",
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders slash command result with command badge and content", () => {
    const message: ConsumerMessage = {
      type: "slash_command_result",
      command: "/help",
      content: "Available commands listed here",
      source: "emulated",
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText("/help")).toBeInTheDocument();
    expect(screen.getByText("Available commands listed here")).toBeInTheDocument();
  });

  it("renders slash command error with failed text", () => {
    const message: ConsumerMessage = {
      type: "slash_command_error",
      command: "/bad",
      error: "Unknown command",
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText("/bad failed")).toBeInTheDocument();
    expect(screen.getByText("Unknown command")).toBeInTheDocument();
  });

  it("renders tool_use_summary output content", () => {
    const message: ConsumerMessage = {
      type: "tool_use_summary",
      summary: "read completed",
      tool_use_ids: ["call-1"],
      tool_name: "read",
      status: "completed",
      output: "1: # beamcode\n2: ...",
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("read completed")).toBeInTheDocument();
    expect(screen.getByText(/1: # beamcode/)).toBeInTheDocument();
    expect(screen.getByText(/2: \.\.\./)).toBeInTheDocument();
  });

  it("renders nothing for unknown message types", () => {
    const message: ConsumerMessage = { type: "cli_connected" };
    const { container } = render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("delegates assistant messages to AssistantMessage", () => {
    const message: ConsumerMessage = {
      type: "assistant",
      parent_tool_use_id: null,
      message: makeAssistantContent([{ type: "text", text: "Hi" }]),
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("assistant-message")).toBeInTheDocument();
  });
});
