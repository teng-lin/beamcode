import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { StreamingIndicator } from "./StreamingIndicator";

const SESSION = "stream-test";
const store = () => useStore.getState();

describe("StreamingIndicator", () => {
  beforeEach(() => {
    useStore.setState({ sessionData: {}, sessions: {}, currentSessionId: null });
  });

  it("renders nothing when no streaming data", () => {
    store().ensureSessionData(SESSION);
    const { container } = render(<StreamingIndicator sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when session doesn't exist", () => {
    const { container } = render(<StreamingIndicator sessionId="nonexistent" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Generating..." when streaming active', () => {
    store().ensureSessionData(SESSION);
    store().setStreamingStarted(SESSION, Date.now());
    render(<StreamingIndicator sessionId={SESSION} />);
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("renders streaming markdown content", () => {
    store().ensureSessionData(SESSION);
    store().setStreaming(SESSION, "**hello world**");
    store().setStreamingStarted(SESSION, Date.now());
    render(<StreamingIndicator sessionId={SESSION} />);
    const bold = screen.getByText("hello world");
    expect(bold.tagName).toBe("STRONG");
  });

  it("displays token count when available", () => {
    store().ensureSessionData(SESSION);
    store().setStreamingStarted(SESSION, Date.now());
    store().setStreamingOutputTokens(SESSION, 2500);
    render(<StreamingIndicator sessionId={SESSION} />);
    expect(screen.getByText(/2\.5k tokens/)).toBeInTheDocument();
  });
});
