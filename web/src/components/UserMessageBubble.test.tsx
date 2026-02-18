import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "../test/factories";
import { UserMessageBubble } from "./UserMessageBubble";

describe("UserMessageBubble", () => {
  beforeEach(() => {
    resetStore();
    store().ensureSessionData("s1");
  });

  /** Render the bubble and return the root HTMLElement. */
  function renderBubble(content = "Hi"): HTMLElement {
    render(<UserMessageBubble content={content} sessionId="s1" />);
    return screen.getByText(content);
  }

  it("renders message content", () => {
    render(<UserMessageBubble content="Hello world" sessionId="s1" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("applies fadeSlideIn animation when no flipOrigin exists", () => {
    const el = renderBubble();
    expect(el.className).toContain("animate-fadeSlideIn");
  });

  it("clears flipOrigin after FLIP layout effect runs", () => {
    store().setFlipOrigin("s1", { top: 100, left: 50, width: 300 });

    renderBubble();

    // useLayoutEffect runs synchronously during render
    expect(store().sessionData.s1?.flipOrigin).toBeNull();
  });

  it("applies invert transform from FLIP origin during layout effect", () => {
    store().setFlipOrigin("s1", { top: 100, left: 50, width: 300 });

    // jsdom getBoundingClientRect returns {top:0, left:0}, so delta = origin - 0.
    // rAF does not fire synchronously in jsdom, so we observe the "Invert" phase
    // before the "Play" rAF callback runs.
    const el = renderBubble();

    expect(el.style.transform).toBe("translate(50px, 100px)");
    expect(el.style.opacity).toBe("0.5");
    expect(el.style.transition).toBe("none");
  });

  it("schedules transform removal via requestAnimationFrame", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    store().setFlipOrigin("s1", { top: 0, left: 0, width: 300 });

    const el = renderBubble();

    expect(rafSpy).toHaveBeenCalled();
    // After both rAF callbacks fire, transform and opacity should be cleared
    expect(el.style.transform).toBe("");
    expect(el.style.opacity).toBe("");
    // Transition should be restored for the "Play" phase
    expect(el.style.transition).toContain("transform");
    expect(el.style.transition).toContain("opacity");

    rafSpy.mockRestore();
  });
});
