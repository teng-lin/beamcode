import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkSessionInfo } from "../store";
import { useStore } from "../store";
import { makeSessionInfo, resetStore } from "../test/factories";
import { Sidebar } from "./Sidebar";

vi.mock("../api", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  disconnect: vi.fn(),
}));

import { createSession, deleteSession } from "../api";
import { connectToSession, disconnect } from "../ws";

function setupSessions(...sessions: SdkSessionInfo[]): void {
  const map: Record<string, SdkSessionInfo> = {};
  for (const s of sessions) map[s.sessionId] = s;
  useStore.setState({ sessions: map });
}

/** Create a session and optionally set its sessionStatus (ensures sessionData exists). */
function setupSessionWithStatus(
  info: Parameters<typeof makeSessionInfo>[0],
  sessionStatus?: "idle" | "running" | "compacting" | null,
): void {
  setupSessions(makeSessionInfo(info));
  if (sessionStatus !== undefined) {
    useStore.getState().ensureSessionData(info.sessionId);
    useStore.getState().setSessionStatus(info.sessionId, sessionStatus);
  }
}

describe("Sidebar", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it('renders "BeamCode" branding', () => {
    render(<Sidebar />);
    expect(screen.getByText("BeamCode")).toBeInTheDocument();
  });

  it('renders "No sessions" when list is empty', () => {
    render(<Sidebar />);
    expect(screen.getByText("No sessions")).toBeInTheDocument();
  });

  it("renders session items from store", () => {
    setupSessions(
      makeSessionInfo({ sessionId: "s1", cwd: "/home/user/project-alpha", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", cwd: "/home/user/project-beta", createdAt: 2000 }),
    );
    render(<Sidebar />);

    expect(screen.getByText("project-alpha")).toBeInTheDocument();
    expect(screen.getByText("project-beta")).toBeInTheDocument();
  });

  it("highlights active session with aria-current", () => {
    setupSessions(
      makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
    );
    useStore.setState({ currentSessionId: "s1" });
    render(<Sidebar />);

    const activeItem = screen.getByText("alpha").closest("[role=button]");
    expect(activeItem).toHaveAttribute("aria-current", "page");

    const inactiveItem = screen.getByText("beta").closest("[role=button]");
    expect(inactiveItem).not.toHaveAttribute("aria-current");
  });

  it('renders "New" button', () => {
    render(<Sidebar />);
    expect(screen.getByLabelText("New session")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("renders session names (derived from cwd basename)", () => {
    setupSessions(
      makeSessionInfo({
        sessionId: "s1",
        cwd: "/Users/dev/workspace/my-cool-project",
        createdAt: 1000,
      }),
    );
    render(<Sidebar />);

    expect(screen.getByText("my-cool-project")).toBeInTheDocument();
  });

  // ── handleNewSession ───────────────────────────────────────────────────

  describe("handleNewSession", () => {
    it("creates a session, updates store, connects, and pushes URL", async () => {
      const user = userEvent.setup();
      const newSession = makeSessionInfo({ sessionId: "new-1", cwd: "/tmp/new" });
      vi.mocked(createSession).mockResolvedValueOnce(newSession);

      render(<Sidebar />);
      await user.click(screen.getByLabelText("New session"));

      await waitFor(() => {
        expect(createSession).toHaveBeenCalledWith({});
      });
      expect(useStore.getState().sessions["new-1"]).toBeDefined();
      expect(useStore.getState().currentSessionId).toBe("new-1");
      expect(connectToSession).toHaveBeenCalledWith("new-1");
      // URL should contain the session param
      expect(window.location.search).toContain("session=new-1");
    });

    it("logs error and resets creating state on failure", async () => {
      const user = userEvent.setup();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(createSession).mockRejectedValueOnce(new Error("network error"));

      render(<Sidebar />);
      await user.click(screen.getByLabelText("New session"));

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          "[sidebar] Failed to create session:",
          expect.any(Error),
        );
      });
      // Button should be re-enabled after error
      expect(screen.getByLabelText("New session")).not.toBeDisabled();
      consoleSpy.mockRestore();
    });

    it("prevents double-click while creating", async () => {
      const user = userEvent.setup();
      // Use a promise that we control resolution for
      let resolveCreate!: (v: SdkSessionInfo) => void;
      vi.mocked(createSession).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );

      render(<Sidebar />);
      const btn = screen.getByLabelText("New session");

      // Click once — starts creation
      await user.click(btn);
      expect(createSession).toHaveBeenCalledTimes(1);

      // Button should be disabled while creating
      expect(btn).toBeDisabled();

      // Resolve the pending creation
      resolveCreate(makeSessionInfo({ sessionId: "new-2", cwd: "/tmp" }));
      await waitFor(() => expect(btn).not.toBeDisabled());
    });
  });

  // ── handleDelete ───────────────────────────────────────────────────────

  describe("handleDelete", () => {
    it("deletes active session, switches to next most recent", async () => {
      const user = userEvent.setup();
      vi.mocked(deleteSession).mockResolvedValueOnce(undefined);

      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      useStore.setState({ currentSessionId: "s2" });

      render(<Sidebar />);
      const deleteBtn = screen.getByLabelText("Delete session beta");
      await user.click(deleteBtn);

      await waitFor(() => {
        expect(deleteSession).toHaveBeenCalledWith("s2");
      });
      expect(useStore.getState().sessions["s2"]).toBeUndefined();
      expect(disconnect).toHaveBeenCalled();
      expect(useStore.getState().currentSessionId).toBe("s1");
      expect(connectToSession).toHaveBeenCalledWith("s1");
    });

    it("deletes inactive session without disconnecting", async () => {
      const user = userEvent.setup();
      vi.mocked(deleteSession).mockResolvedValueOnce(undefined);

      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      useStore.setState({ currentSessionId: "s1" });

      render(<Sidebar />);
      const deleteBtn = screen.getByLabelText("Delete session beta");
      await user.click(deleteBtn);

      await waitFor(() => {
        expect(deleteSession).toHaveBeenCalledWith("s2");
      });
      expect(useStore.getState().sessions["s2"]).toBeUndefined();
      expect(disconnect).not.toHaveBeenCalled();
      // Active session should remain unchanged
      expect(useStore.getState().currentSessionId).toBe("s1");
    });

    it("deletes last session and sets currentSessionId to null", async () => {
      const user = userEvent.setup();
      vi.mocked(deleteSession).mockResolvedValueOnce(undefined);

      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/home/user/only", createdAt: 1000 }));
      useStore.setState({ currentSessionId: "s1" });

      render(<Sidebar />);
      const deleteBtn = screen.getByLabelText("Delete session only");
      await user.click(deleteBtn);

      await waitFor(() => {
        expect(deleteSession).toHaveBeenCalledWith("s1");
      });
      expect(useStore.getState().sessions["s1"]).toBeUndefined();
      expect(useStore.getState().currentSessionId).toBeNull();
      expect(disconnect).toHaveBeenCalled();
    });

    it("handles deleteSession API failure gracefully (removes locally)", async () => {
      const user = userEvent.setup();
      vi.mocked(deleteSession).mockRejectedValueOnce(new Error("gone"));

      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }));
      useStore.setState({ currentSessionId: "s1" });

      render(<Sidebar />);
      const deleteBtn = screen.getByLabelText("Delete session alpha");
      await user.click(deleteBtn);

      await waitFor(() => {
        // Session should still be removed locally even if API fails
        expect(useStore.getState().sessions["s1"]).toBeUndefined();
      });
    });
  });

  // ── adapterColor ───────────────────────────────────────────────────────

  describe("adapterColor", () => {
    it("renders claude adapter color for claude session", () => {
      setupSessions(
        makeSessionInfo({
          sessionId: "s1",
          cwd: "/tmp/proj",
          createdAt: 1000,
          adapterType: "claude",
        }),
      );
      render(<Sidebar />);
      const row = screen.getByText("proj").closest("[role=button]")!;
      const adapterDot = row.querySelector("[class*='bg-bc-adapter']");
      expect(adapterDot?.className).toContain("bg-bc-adapter-claude");
    });

    it("renders default adapter color for unknown adapter type", () => {
      setupSessions(
        makeSessionInfo({
          sessionId: "s1",
          cwd: "/tmp/proj",
          createdAt: 1000,
          adapterType: "unknown-adapter",
        }),
      );
      render(<Sidebar />);
      const row = screen.getByText("proj").closest("[role=button]")!;
      const adapterDot = row.querySelector("[class*='bg-bc-adapter']");
      expect(adapterDot?.className).toContain("bg-bc-adapter-default");
    });

    it("renders default adapter color when adapterType is undefined", () => {
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000 }));
      render(<Sidebar />);
      const row = screen.getByText("proj").closest("[role=button]")!;
      const adapterDot = row.querySelector("[class*='bg-bc-adapter']");
      expect(adapterDot?.className).toContain("bg-bc-adapter-default");
    });
  });

  // ── StatusDot ──────────────────────────────────────────────────────────

  describe("StatusDot", () => {
    it("shows Running label for running status", () => {
      setupSessionWithStatus(
        { sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "running" },
        "running",
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
    });

    it("shows Idle label for idle status", () => {
      setupSessionWithStatus(
        { sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "connected" },
        "idle",
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Idle" })).toBeInTheDocument();
    });

    it("shows Connected label when sessionStatus is null and state is connected", () => {
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "connected" }),
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Connected" })).toBeInTheDocument();
    });

    it("shows Offline label for unknown status string", () => {
      setupSessionWithStatus(
        { sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "connected" },
        "some-unknown" as "idle",
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Offline" })).toBeInTheDocument();
    });
  });

  // ── formatTime ─────────────────────────────────────────────────────────

  describe("formatTime", () => {
    it("shows time for same-day session", () => {
      const now = Date.now();
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/tmp/proj", createdAt: now }));
      render(<Sidebar />);
      // The time should contain a colon (e.g., "3:45 PM")
      const timeEl = screen.getByText("proj").closest("[role=button]");
      const timeText = timeEl?.querySelector(".text-\\[10px\\]")?.textContent ?? "";
      expect(timeText).toMatch(/\d{1,2}:\d{2}/);
    });

    it("shows date for different-day session", () => {
      // Use a date from a month ago
      const oldDate = new Date();
      oldDate.setMonth(oldDate.getMonth() - 1);
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/tmp/proj", createdAt: oldDate.getTime() }),
      );
      render(<Sidebar />);
      const timeEl = screen.getByText("proj").closest("[role=button]");
      const timeText = timeEl?.querySelector(".text-\\[10px\\]")?.textContent ?? "";
      // Should contain a month abbreviation (e.g., "Jan 15")
      expect(timeText).toMatch(/[A-Z][a-z]{2}\s+\d{1,2}/);
    });
  });

  // ── resolveStatus ──────────────────────────────────────────────────────

  describe("resolveStatus", () => {
    it("shows Exited label when session state is exited, regardless of sessionStatus", () => {
      setupSessionWithStatus(
        { sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "exited" },
        "running",
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Exited" })).toBeInTheDocument();
    });

    it("uses sessionStatus when state is not exited", () => {
      setupSessionWithStatus(
        { sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "connected" },
        "compacting",
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Compacting" })).toBeInTheDocument();
    });

    it("falls back to info.state when sessionStatus is null", () => {
      setupSessionWithStatus(
        { sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000, state: "starting" },
        null,
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Starting" })).toBeInTheDocument();
    });
  });

  // ── Session search ──────────────────────────────────────────────────────

  describe("session search", () => {
    it("renders search input when sessions exist", () => {
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }));
      render(<Sidebar />);
      expect(screen.getByPlaceholderText("Search sessions...")).toBeInTheDocument();
    });

    it("filters sessions by cwd basename", async () => {
      const user = userEvent.setup();
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
        makeSessionInfo({
          sessionId: "s3",
          name: "My Project",
          cwd: "/home/user/gamma",
          createdAt: 3000,
        }),
      );
      render(<Sidebar />);

      await user.type(screen.getByPlaceholderText("Search sessions..."), "alpha");
      expect(screen.getByText("alpha")).toBeInTheDocument();
      expect(screen.queryByText("beta")).not.toBeInTheDocument();
      expect(screen.queryByText("My Project")).not.toBeInTheDocument();
    });

    it("filters are case-insensitive", async () => {
      const user = userEvent.setup();
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/home/user/Alpha", createdAt: 1000 }));
      render(<Sidebar />);

      await user.type(screen.getByPlaceholderText("Search sessions..."), "alpha");
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });

    it("matches against session name property", async () => {
      const user = userEvent.setup();
      setupSessions(
        makeSessionInfo({
          sessionId: "s1",
          name: "Cool Project",
          cwd: "/home/user/proj",
          createdAt: 1000,
        }),
      );
      render(<Sidebar />);

      await user.type(screen.getByPlaceholderText("Search sessions..."), "cool");
      expect(screen.getByText("Cool Project")).toBeInTheDocument();
    });

    it('shows "No matches" when filter has no results', async () => {
      const user = userEvent.setup();
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }));
      render(<Sidebar />);

      await user.type(screen.getByPlaceholderText("Search sessions..."), "zzzzz");
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    it("does not show search input when no sessions exist", () => {
      render(<Sidebar />);
      expect(screen.queryByPlaceholderText("Search sessions...")).not.toBeInTheDocument();
    });
  });

  // ── Keyboard navigation ────────────────────────────────────────────────

  describe("keyboard navigation", () => {
    it("triggers onSelect when Enter is pressed on a session item", async () => {
      const user = userEvent.setup();
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      render(<Sidebar />);

      const item = screen.getByText("alpha").closest("[role=button]")!;
      item.focus();
      await user.keyboard("{Enter}");

      expect(useStore.getState().currentSessionId).toBe("s1");
    });

    it("triggers onSelect when Space is pressed on a session item", async () => {
      const user = userEvent.setup();
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      render(<Sidebar />);

      const item = screen.getByText("alpha").closest("[role=button]")!;
      item.focus();
      await user.keyboard(" ");

      expect(useStore.getState().currentSessionId).toBe("s1");
    });
  });
});
