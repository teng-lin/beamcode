import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../store";
import { useStore } from "../store";
import { checkA11y } from "../test/a11y";
import { makeSessionInfo, resetStore } from "../test/factories";
import { Sidebar } from "./Sidebar";

vi.mock("../api", () => ({
  archiveSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  disconnect: vi.fn(),
  disconnectSession: vi.fn(),
}));

import { archiveSession, createSession, deleteSession, unarchiveSession } from "../api";
import { connectToSession, disconnect, disconnectSession } from "../ws";

function setupSessions(...sessions: SessionInfo[]): void {
  const map: Record<string, SessionInfo> = {};
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

    // Text may appear in both group header and session item when grouping is active
    expect(screen.getAllByText("project-alpha").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("project-beta").length).toBeGreaterThanOrEqual(1);
  });

  it("highlights active session with aria-current", () => {
    setupSessions(
      makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
    );
    useStore.setState({ currentSessionId: "s1" });
    render(<Sidebar />);

    // With grouping, text appears in both group header and session item.
    // Find the one inside a [role=button] (the session item, not the group summary).
    const activeItem = screen
      .getAllByText("alpha")
      .map((el) => el.closest("[role=button]"))
      .find((el) => el !== null);
    expect(activeItem).toHaveAttribute("aria-current", "page");

    const inactiveItem = screen
      .getAllByText("beta")
      .map((el) => el.closest("[role=button]"))
      .find((el) => el !== null);
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
    it("opens the new session dialog when New button is clicked", async () => {
      const user = userEvent.setup();
      render(<Sidebar />);
      await user.click(screen.getByLabelText("New session"));
      expect(useStore.getState().newSessionDialogOpen).toBe(true);
      expect(createSession).not.toHaveBeenCalled();
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
      expect(useStore.getState().sessions.s2).toBeUndefined();
      expect(disconnectSession).toHaveBeenCalledWith("s2");
      expect(useStore.getState().currentSessionId).toBe("s1");
      expect(connectToSession).toHaveBeenCalledWith("s1");
    });

    it("deletes inactive session, cleans up its connection but keeps others", async () => {
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
      expect(useStore.getState().sessions.s2).toBeUndefined();
      expect(disconnectSession).toHaveBeenCalledWith("s2");
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
      expect(useStore.getState().sessions.s1).toBeUndefined();
      expect(useStore.getState().currentSessionId).toBeNull();
      expect(disconnectSession).toHaveBeenCalledWith("s1");
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
        expect(useStore.getState().sessions.s1).toBeUndefined();
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
      const row = screen.getByText("proj").closest("[role=button]") as HTMLElement;
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
      const row = screen.getByText("proj").closest("[role=button]") as HTMLElement;
      const adapterDot = row.querySelector("[class*='bg-bc-adapter']");
      expect(adapterDot?.className).toContain("bg-bc-adapter-default");
    });

    it("renders default adapter color when adapterType is undefined", () => {
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/tmp/proj", createdAt: 1000 }));
      render(<Sidebar />);
      const row = screen.getByText("proj").closest("[role=button]") as HTMLElement;
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

    it("shows exit code in tooltip when state is exited", () => {
      setupSessions(
        makeSessionInfo({
          sessionId: "s1",
          cwd: "/tmp/proj",
          createdAt: 1000,
          state: "exited",
          exitCode: 1,
        }),
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Exited (code 1)" })).toBeInTheDocument();
    });

    it("shows plain Exited label when no exit code", () => {
      setupSessions(
        makeSessionInfo({
          sessionId: "s1",
          cwd: "/tmp/proj",
          createdAt: 1000,
          state: "exited",
        }),
      );
      render(<Sidebar />);
      expect(screen.getByRole("img", { name: "Exited" })).toBeInTheDocument();
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

    it("shows all sessions when search is cleared", async () => {
      const user = userEvent.setup();
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      render(<Sidebar />);

      const input = screen.getByPlaceholderText("Search sessions...");
      await user.type(input, "alpha");
      expect(screen.queryByText("beta")).not.toBeInTheDocument();

      await user.clear(input);
      // With grouping, text may appear in both header and session item
      expect(screen.getAllByText("alpha").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("beta").length).toBeGreaterThanOrEqual(1);
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

  // ── Accessibility ──────────────────────────────────────────────────────

  describe("accessibility", () => {
    it("has no axe violations in empty state", async () => {
      render(<Sidebar />);
      const results = await checkA11y();
      expect(results).toHaveNoViolations();
    });

    it("has no axe violations with sessions (except known nested-interactive)", async () => {
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      render(<Sidebar />);
      // Known issue: session rows use role="button" with nested action buttons.
      // Disable nested-interactive to test for other violations; tracked separately.
      const results = await checkA11y(document.body, {
        rules: { "nested-interactive": { enabled: false } },
      });
      expect(results).toHaveNoViolations();
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

      const item = screen
        .getAllByText("alpha")
        .map((el) => el.closest("[role=button]"))
        .find((el) => el !== null) as HTMLElement;
      item.focus();
      await user.keyboard("{Enter}");

      expect(useStore.getState().currentSessionId).toBe("s1");
      expect(connectToSession).toHaveBeenCalledWith("s1");
    });

    it("triggers onSelect when Space is pressed on a session item", async () => {
      const user = userEvent.setup();
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      render(<Sidebar />);

      const item = screen
        .getAllByText("alpha")
        .map((el) => el.closest("[role=button]"))
        .find((el) => el !== null) as HTMLElement;
      item.focus();
      await user.keyboard(" ");

      expect(useStore.getState().currentSessionId).toBe("s1");
      expect(connectToSession).toHaveBeenCalledWith("s1");
    });
  });

  // ── Archive management ────────────────────────────────────────────────

  describe("archive management", () => {
    it("separates active and archived sessions", () => {
      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/active-proj", createdAt: 2000 }),
        makeSessionInfo({
          sessionId: "s2",
          cwd: "/home/user/old-proj",
          createdAt: 1000,
          archived: true,
        }),
      );
      render(<Sidebar />);

      // Active session visible directly
      expect(screen.getByText("active-proj")).toBeInTheDocument();
      // Archived section header with count
      expect(screen.getByText(/Archived \(1\)/)).toBeInTheDocument();
    });

    it("renders archived sessions with reduced opacity", () => {
      setupSessions(
        makeSessionInfo({
          sessionId: "s1",
          cwd: "/home/user/old-proj",
          createdAt: 1000,
          archived: true,
        }),
      );
      render(<Sidebar />);

      const row = screen.getByText("old-proj").closest("[role=button]");
      expect(row?.className).toContain("opacity-60");
    });

    it("archives a session via API and updates store", async () => {
      const user = userEvent.setup();
      vi.mocked(archiveSession).mockResolvedValueOnce(undefined);

      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 2000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 1000 }),
      );
      useStore.setState({ currentSessionId: "s2" });
      render(<Sidebar />);

      const archiveBtn = screen.getByLabelText("Archive session alpha");
      await user.click(archiveBtn);

      await waitFor(() => {
        expect(archiveSession).toHaveBeenCalledWith("s1");
      });
      expect(useStore.getState().sessions.s1.archived).toBe(true);
    });

    it("archiving active session switches to next active session", async () => {
      const user = userEvent.setup();
      vi.mocked(archiveSession).mockResolvedValueOnce(undefined);

      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }),
        makeSessionInfo({ sessionId: "s2", cwd: "/home/user/beta", createdAt: 2000 }),
      );
      useStore.setState({ currentSessionId: "s2" });
      render(<Sidebar />);

      const archiveBtn = screen.getByLabelText("Archive session beta");
      await user.click(archiveBtn);

      await waitFor(() => {
        expect(archiveSession).toHaveBeenCalledWith("s2");
      });
      expect(useStore.getState().currentSessionId).toBe("s1");
      expect(connectToSession).toHaveBeenCalledWith("s1");
      expect(disconnectSession).toHaveBeenCalledWith("s2");
    });

    it("unarchives a session via API and updates store", async () => {
      const user = userEvent.setup();
      vi.mocked(unarchiveSession).mockResolvedValueOnce(undefined);

      setupSessions(
        makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 2000 }),
        makeSessionInfo({
          sessionId: "s2",
          cwd: "/home/user/old-proj",
          createdAt: 1000,
          archived: true,
        }),
      );
      render(<Sidebar />);

      // Open the archived section
      const archivedSummary = screen.getByText(/Archived/);
      await user.click(archivedSummary);

      const unarchiveBtn = screen.getByLabelText("Unarchive session old-proj");
      await user.click(unarchiveBtn);

      await waitFor(() => {
        expect(unarchiveSession).toHaveBeenCalledWith("s2");
      });
      expect(useStore.getState().sessions.s2.archived).toBe(false);
    });

    it("does not show archived section when no archived sessions exist", () => {
      setupSessions(makeSessionInfo({ sessionId: "s1", cwd: "/home/user/alpha", createdAt: 1000 }));
      render(<Sidebar />);

      expect(screen.queryByText(/Archived/)).not.toBeInTheDocument();
    });
  });
});
