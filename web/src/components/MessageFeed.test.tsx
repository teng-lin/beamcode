import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { checkA11y } from "../test/a11y";
import { makeAssistantMessage } from "../test/factories";
import { MessageFeed } from "./MessageFeed";

// jsdom doesn't implement scrollIntoView — stub it to prevent unhandled errors
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ message }: { message: ConsumerMessage }) => (
    <div data-testid="message-bubble">{message.type}</div>
  ),
}));
vi.mock("./ResultBanner", () => ({
  ResultBanner: () => <div data-testid="result-banner" />,
}));

const SESSION_ID = "test-session";

describe("MessageFeed", () => {
  it("renders a log element with message history label", () => {
    render(<MessageFeed messages={[]} sessionId={SESSION_ID} />);
    const log = screen.getByRole("log");
    expect(log).toBeInTheDocument();
    expect(log).toHaveAttribute("aria-label", "Message history");
  });

  it("renders message bubbles for regular messages", () => {
    const messages: ConsumerMessage[] = [
      { type: "user_message", content: "Hi", timestamp: Date.now() },
      { type: "error", message: "Oops" },
    ];
    render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
    const bubbles = screen.getAllByTestId("message-bubble");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toHaveTextContent("user_message");
    expect(bubbles[1]).toHaveTextContent("error");
  });

  it("renders result banner for result messages", () => {
    const messages: ConsumerMessage[] = [
      {
        type: "result",
        data: {
          subtype: "success",
          is_error: false,
          duration_ms: 1000,
          duration_api_ms: 900,
          num_turns: 1,
          total_cost_usd: 0.01,
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ];
    render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
    expect(screen.getByTestId("result-banner")).toBeInTheDocument();
  });

  it("groups subagent messages (assistant with parent_tool_use_id) in details", () => {
    const messages: ConsumerMessage[] = [
      makeAssistantMessage("parent-tu-1", "msg-1"),
      makeAssistantMessage("parent-tu-1", "msg-2"),
    ];
    render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
    const details = document.querySelector("details");
    expect(details).toBeInTheDocument();
    const bubbles = screen.getAllByTestId("message-bubble");
    expect(bubbles).toHaveLength(2);
  });

  it('renders "Subagent" label for grouped messages', () => {
    const messages: ConsumerMessage[] = [makeAssistantMessage("parent-tu-1", "msg-1")];
    render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
    expect(screen.getByText("Subagent")).toBeInTheDocument();
  });

  it("shows subagent message count badge", () => {
    const messages: ConsumerMessage[] = [
      makeAssistantMessage("parent-tu-1", "msg-1"),
      makeAssistantMessage("parent-tu-1", "msg-2"),
      makeAssistantMessage("parent-tu-1", "msg-3"),
    ];
    render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not group assistant messages without parent_tool_use_id", () => {
    const messages: ConsumerMessage[] = [
      makeAssistantMessage(null, "msg-1"),
      makeAssistantMessage(null, "msg-2"),
    ];
    render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
    const details = document.querySelector("details");
    expect(details).toBeNull();
    const bubbles = screen.getAllByTestId("message-bubble");
    expect(bubbles).toHaveLength(2);
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  describe("accessibility", () => {
    it("has no axe violations with messages", async () => {
      const messages: ConsumerMessage[] = [
        { type: "user_message", content: "Hello", timestamp: Date.now() },
      ];
      render(<MessageFeed messages={messages} sessionId={SESSION_ID} />);
      const results = await checkA11y();
      expect(results).toHaveNoViolations();
    });
  });
});
