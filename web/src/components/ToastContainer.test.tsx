import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { ToastContainer } from "./ToastContainer";

describe("ToastContainer", () => {
  beforeEach(() => {
    useStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing when there are no toasts", () => {
    const { container } = render(<ToastContainer />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a toast when added", () => {
    act(() => useStore.getState().addToast("Hello world", "info"));
    render(<ToastContainer />);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("auto-dismisses info/success toasts after ttl", () => {
    act(() => useStore.getState().addToast("Auto dismiss", "success", 3000));
    render(<ToastContainer />);
    expect(screen.getByText("Auto dismiss")).toBeTruthy();

    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("Auto dismiss")).toBeNull();
  });

  it("does not auto-dismiss error toasts (ttl=0)", () => {
    act(() => useStore.getState().addToast("Error toast", "error"));
    render(<ToastContainer />);
    expect(screen.getByText("Error toast")).toBeTruthy();

    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("Error toast")).toBeTruthy();
  });

  it("removes toast on dismiss click", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    act(() => useStore.getState().addToast("Dismiss me", "error"));
    render(<ToastContainer />);
    expect(screen.getByText("Dismiss me")).toBeTruthy();

    await user.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Dismiss me")).toBeNull();
  });

  it("limits to MAX_TOASTS (5) with FIFO eviction", () => {
    act(() => {
      for (let i = 0; i < 7; i++) {
        useStore.getState().addToast(`Toast ${i}`, "error");
      }
    });
    expect(useStore.getState().toasts).toHaveLength(5);
    // Oldest two should be evicted
    expect(useStore.getState().toasts[0].message).toBe("Toast 2");
  });

  it("applies correct style classes per type", () => {
    act(() => {
      useStore.getState().addToast("Info", "info");
      useStore.getState().addToast("Error", "error");
      useStore.getState().addToast("Success", "success");
    });
    render(<ToastContainer />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(3);
    expect(alerts[0].className).toContain("border-bc-accent");
    expect(alerts[1].className).toContain("border-bc-error");
    expect(alerts[2].className).toContain("border-bc-success");
  });
});
