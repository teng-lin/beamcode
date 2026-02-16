import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConsumerMessage } from "../../../shared/consumer-types";
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

  it("renders nothing for unknown message types", () => {
    // "cli_connected" is a valid ConsumerMessage type but not handled by MessageBubble
    const message: ConsumerMessage = { type: "cli_connected" };
    const { container } = render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("delegates assistant messages to AssistantMessage", () => {
    const message: ConsumerMessage = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-3-opus",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    render(<MessageBubble message={message} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("assistant-message")).toBeInTheDocument();
  });
});
