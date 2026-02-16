# Phase 1: Frontend Quick Wins Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the 8 most painful UI gaps identified in the competitive analysis — all frontend-only, zero backend changes.

**Architecture:** Each feature is a self-contained addition to the existing React 19 + Zustand 5 + Tailwind v4 frontend in `web/`. Features modify existing components or add new ones alongside them. All state flows through the existing Zustand store (`web/src/store.ts`). WebSocket communication uses the existing `send()` from `web/src/ws.ts`. Tests use vitest + @testing-library/react with the existing factory helpers in `web/src/test/factories.ts`.

**Tech Stack:** React 19, Zustand 5, Tailwind CSS v4, Vite, vitest, @testing-library/react, @testing-library/user-event

**Reference docs:**
- Competitive analysis: `docs/reviews/2026-02-16-competitive-ui-gap-analysis.md`
- Consumer types: `shared/consumer-types.ts`
- Test factories: `web/src/test/factories.ts`

---

## Task 1: Session Search in Sidebar

**Effort: S (~0.5 day)**

Adds a search input to the Sidebar that filters sessions by name. This is the simplest feature and warms up the development workflow.

**Files:**
- Modify: `web/src/components/Sidebar.tsx:162-251` (the `Sidebar` component)
- Test: `web/src/components/Sidebar.test.tsx`

### Step 1: Write failing tests for session search

Add to `web/src/components/Sidebar.test.tsx` inside the top-level `describe("Sidebar", ...)`:

```tsx
// ── Session search ──────────────────────────────────────────────────

describe("session search", () => {
  it("renders a search input", () => {
    render(<Sidebar />);
    expect(screen.getByPlaceholderText("Search sessions...")).toBeInTheDocument();
  });

  it("filters sessions by name match", async () => {
    const user = userEvent.setup();
    setupSessions(
      makeSessionInfo({ sessionId: "s1", name: "Auth refactor", cwd: "/tmp/auth", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", name: "API tests", cwd: "/tmp/api", createdAt: 2000 }),
      makeSessionInfo({ sessionId: "s3", name: "Dashboard UI", cwd: "/tmp/dash", createdAt: 3000 }),
    );
    render(<Sidebar />);

    await user.type(screen.getByPlaceholderText("Search sessions..."), "auth");

    expect(screen.getByText("Auth refactor")).toBeInTheDocument();
    expect(screen.queryByText("API tests")).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard UI")).not.toBeInTheDocument();
  });

  it("filters sessions by cwd basename when name is undefined", async () => {
    const user = userEvent.setup();
    setupSessions(
      makeSessionInfo({ sessionId: "s1", cwd: "/home/user/my-project", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", cwd: "/home/user/other-thing", createdAt: 2000 }),
    );
    render(<Sidebar />);

    await user.type(screen.getByPlaceholderText("Search sessions..."), "my-proj");

    expect(screen.getByText("my-project")).toBeInTheDocument();
    expect(screen.queryByText("other-thing")).not.toBeInTheDocument();
  });

  it("is case-insensitive", async () => {
    const user = userEvent.setup();
    setupSessions(
      makeSessionInfo({ sessionId: "s1", name: "Auth Refactor", cwd: "/tmp/auth", createdAt: 1000 }),
    );
    render(<Sidebar />);

    await user.type(screen.getByPlaceholderText("Search sessions..."), "AUTH");

    expect(screen.getByText("Auth Refactor")).toBeInTheDocument();
  });

  it("shows all sessions when search is cleared", async () => {
    const user = userEvent.setup();
    setupSessions(
      makeSessionInfo({ sessionId: "s1", name: "Alpha", cwd: "/tmp/a", createdAt: 1000 }),
      makeSessionInfo({ sessionId: "s2", name: "Beta", cwd: "/tmp/b", createdAt: 2000 }),
    );
    render(<Sidebar />);

    const input = screen.getByPlaceholderText("Search sessions...");
    await user.type(input, "Alpha");
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();

    await user.clear(input);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("shows 'No matching sessions' when search has no results", async () => {
    const user = userEvent.setup();
    setupSessions(
      makeSessionInfo({ sessionId: "s1", name: "Alpha", cwd: "/tmp/a", createdAt: 1000 }),
    );
    render(<Sidebar />);

    await user.type(screen.getByPlaceholderText("Search sessions..."), "zzzzz");

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/Sidebar.test.tsx`
Expected: FAIL — "Search sessions..." placeholder not found

### Step 3: Implement session search

In `web/src/components/Sidebar.tsx`, add search state and filter logic:

1. Add `searchQuery` state inside `Sidebar()`:

```tsx
const [searchQuery, setSearchQuery] = useState("");
```

2. Filter `sessionList` by search query. Replace the existing `sessionList` computation (lines 188-193) with:

```tsx
const sessionList = Object.values(sessions)
  .filter(
    (s): s is SdkSessionInfo =>
      s != null && typeof s.sessionId === "string" && typeof s.createdAt === "number",
  )
  .filter((s) => {
    if (!searchQuery) return true;
    const name = s.name ?? cwdBasename(s.cwd ?? "");
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  })
  .sort((a, b) => b.createdAt - a.createdAt);
```

3. Add search input between the header `</div>` and `<nav>` (after line 232, before line 234):

```tsx
{/* Search */}
<div className="border-b border-bc-border px-3 py-2">
  <input
    type="text"
    value={searchQuery}
    onChange={(e) => setSearchQuery(e.target.value)}
    placeholder="Search sessions..."
    className="w-full rounded-md border border-bc-border bg-bc-bg px-2.5 py-1.5 text-xs text-bc-text placeholder:text-bc-text-muted/50 focus:border-bc-accent/50 focus:outline-none"
    aria-label="Search sessions"
  />
</div>
```

4. Update the empty state message inside `<nav>` to differentiate between "no sessions" and "no matching sessions":

```tsx
{sessionList.length === 0 ? (
  <div className="px-4 py-8 text-center text-xs text-bc-text-muted">
    {searchQuery ? "No matching sessions" : "No sessions"}
  </div>
) : (
  sessionList.map((info) => (
    // ... existing SessionItem rendering
  ))
)}
```

### Step 4: Run tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/Sidebar.test.tsx`
Expected: ALL PASS

### Step 5: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/components/Sidebar.tsx web/src/components/Sidebar.test.tsx
git commit -m "feat: add session search to sidebar"
```

---

## Task 2: "Allow All" Button on PermissionBanner

**Effort: S (~0.5 day)**

When multiple permissions are pending (common during sequential file edits), users must click Allow 5-10 times. Add an "Allow All" button that approves all pending permissions in one click.

**Files:**
- Modify: `web/src/components/PermissionBanner.tsx:59-131` (the `PermissionBanner` component)
- Test: `web/src/components/PermissionBanner.test.tsx`

### Step 1: Write failing tests

Add to `web/src/components/PermissionBanner.test.tsx`:

```tsx
// ── Allow All ───────────────────────────────────────────────────────

describe("Allow All", () => {
  it("does not show Allow All when only one permission is pending", () => {
    renderWithPermission(makePermission());
    expect(screen.queryByRole("button", { name: /allow all/i })).not.toBeInTheDocument();
  });

  it("shows Allow All button when multiple permissions are pending", () => {
    renderWithPermission(
      makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
      makePermission({ request_id: "req-2", tool_use_id: "tu-2", tool_name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" } }),
    );
    expect(screen.getByRole("button", { name: /allow all/i })).toBeInTheDocument();
  });

  it("sends allow response for all permissions when clicked", async () => {
    const user = userEvent.setup();
    renderWithPermission(
      makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
      makePermission({ request_id: "req-2", tool_use_id: "tu-2", tool_name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" } }),
      makePermission({ request_id: "req-3", tool_use_id: "tu-3", tool_name: "Write", input: { file_path: "/tmp/b.ts", content: "x" } }),
    );

    await user.click(screen.getByRole("button", { name: /allow all/i }));

    expect(ws.send).toHaveBeenCalledTimes(3);
    expect(ws.send).toHaveBeenCalledWith({ type: "permission_response", request_id: "req-1", behavior: "allow" });
    expect(ws.send).toHaveBeenCalledWith({ type: "permission_response", request_id: "req-2", behavior: "allow" });
    expect(ws.send).toHaveBeenCalledWith({ type: "permission_response", request_id: "req-3", behavior: "allow" });
  });

  it("removes all permissions from store after Allow All", async () => {
    const user = userEvent.setup();
    renderWithPermission(
      makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
      makePermission({ request_id: "req-2", tool_use_id: "tu-2", tool_name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" } }),
    );

    await user.click(screen.getByRole("button", { name: /allow all/i }));

    const perms = store().sessionData[SESSION_ID].pendingPermissions;
    expect(Object.keys(perms)).toHaveLength(0);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/PermissionBanner.test.tsx`
Expected: FAIL — "allow all" button not found

### Step 3: Implement "Allow All"

In `web/src/components/PermissionBanner.tsx`:

1. Add `handleAllowAll` callback after the existing `handleResponse`:

```tsx
const handleAllowAll = useCallback(() => {
  for (const perm of permList) {
    send({ type: "permission_response", request_id: perm.request_id, behavior: "allow" });
    useStore.getState().removePermission(sessionId, perm.request_id);
  }
}, [sessionId, permList]);
```

2. Add the "Allow All" bar at the top of the permission container, inside the outer `<div>` but before the `{permList.map(...)}`. Only show when `permList.length > 1`:

```tsx
{permList.length > 1 && (
  <div className="flex items-center justify-between border-b border-bc-border bg-bc-surface-2/50 px-4 py-2">
    <span className="text-xs text-bc-text-muted">
      {permList.length} pending permissions
    </span>
    <button
      type="button"
      onClick={handleAllowAll}
      className="rounded-lg bg-bc-success/20 px-4 py-1.5 text-xs font-medium text-bc-success transition-colors hover:bg-bc-success/30"
      aria-label={`Allow all ${permList.length} permissions`}
    >
      Allow All
    </button>
  </div>
)}
```

### Step 4: Run tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/PermissionBanner.test.tsx`
Expected: ALL PASS

### Step 5: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/components/PermissionBanner.tsx web/src/components/PermissionBanner.test.tsx
git commit -m "feat: add Allow All button to PermissionBanner"
```

---

## Task 3: Keyboard Shortcuts

**Effort: S (~1 day)**

Add global keyboard shortcuts and a discoverable shortcuts modal (triggered by `?`).

**Files:**
- Create: `web/src/components/ShortcutsModal.tsx`
- Create: `web/src/components/ShortcutsModal.test.tsx`
- Create: `web/src/hooks/useKeyboardShortcuts.ts`
- Create: `web/src/hooks/useKeyboardShortcuts.test.ts`
- Modify: `web/src/App.tsx:83-129` (add shortcut hook + modal)
- Modify: `web/src/store.ts` (add `shortcutsModalOpen` state)

### Step 1: Write failing tests for the keyboard shortcut hook

Create `web/src/hooks/useKeyboardShortcuts.test.ts`:

```ts
import { renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "../test/factories";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../api", () => ({
  createSession: vi.fn(),
}));

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("toggles sidebar on Cmd+B", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    store().toggleSidebar(); // ensure it's open first (resetStore sets sidebarOpen: false)
    expect(store().sidebarOpen).toBe(true);

    await user.keyboard("{Meta>}b{/Meta}");

    expect(store().sidebarOpen).toBe(false);
  });

  it("toggles task panel on Cmd+.", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    expect(store().taskPanelOpen).toBe(false);

    await user.keyboard("{Meta>}.{/Meta}");

    expect(store().taskPanelOpen).toBe(true);
  });

  it("opens shortcuts modal on ?", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    expect(store().shortcutsModalOpen).toBeFalsy();

    await user.keyboard("?");

    expect(store().shortcutsModalOpen).toBe(true);
  });

  it("does not trigger ? shortcut when typing in an input/textarea", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    await user.keyboard("?");

    expect(store().shortcutsModalOpen).toBeFalsy();
    document.body.removeChild(textarea);
  });

  it("closes shortcuts modal on Escape", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    // Open it first
    store().setShortcutsModalOpen(true);
    expect(store().shortcutsModalOpen).toBe(true);

    await user.keyboard("{Escape}");

    expect(store().shortcutsModalOpen).toBe(false);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/hooks/useKeyboardShortcuts.test.ts`
Expected: FAIL — module not found

### Step 3: Add store state for shortcuts modal

In `web/src/store.ts`, add to `AppState` interface (after line 55):

```ts
shortcutsModalOpen: boolean;
```

Add action (after line 61):

```ts
setShortcutsModalOpen: (open: boolean) => void;
```

Add initial state (after line 144):

```ts
shortcutsModalOpen: false,
```

Add action implementation (after line 149):

```ts
setShortcutsModalOpen: (open) => set({ shortcutsModalOpen: open }),
```

### Step 4: Implement the keyboard shortcuts hook

Create `web/src/hooks/useKeyboardShortcuts.ts`:

```ts
import { useEffect } from "react";
import { useStore } from "../store";

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const state = useStore.getState();

      // Cmd/Ctrl+B: toggle sidebar
      if (meta && e.key === "b") {
        e.preventDefault();
        state.toggleSidebar();
        return;
      }

      // Cmd/Ctrl+.: toggle task panel
      if (meta && e.key === ".") {
        e.preventDefault();
        state.toggleTaskPanel();
        return;
      }

      // Escape: close shortcuts modal (if open)
      if (e.key === "Escape" && state.shortcutsModalOpen) {
        e.preventDefault();
        state.setShortcutsModalOpen(false);
        return;
      }

      // ?: open shortcuts modal (only when not typing in input)
      if (e.key === "?" && !meta && !e.altKey && !isInputFocused()) {
        e.preventDefault();
        state.setShortcutsModalOpen(true);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
```

### Step 5: Run hook tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/hooks/useKeyboardShortcuts.test.ts`
Expected: ALL PASS

### Step 6: Write failing tests for ShortcutsModal

Create `web/src/components/ShortcutsModal.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, store } from "../test/factories";
import { ShortcutsModal } from "./ShortcutsModal";

describe("ShortcutsModal", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when shortcutsModalOpen is false", () => {
    const { container } = render(<ShortcutsModal />);
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when shortcutsModalOpen is true", () => {
    store().setShortcutsModalOpen(true);
    render(<ShortcutsModal />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
  });

  it("lists key shortcuts", () => {
    store().setShortcutsModalOpen(true);
    render(<ShortcutsModal />);
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle task panel")).toBeInTheDocument();
    expect(screen.getByText("Show shortcuts")).toBeInTheDocument();
  });

  it("closes when clicking the backdrop", async () => {
    const user = userEvent.setup();
    store().setShortcutsModalOpen(true);
    render(<ShortcutsModal />);

    await user.click(screen.getByTestId("shortcuts-backdrop"));

    expect(store().shortcutsModalOpen).toBe(false);
  });
});
```

### Step 7: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/ShortcutsModal.test.tsx`
Expected: FAIL — module not found

### Step 8: Implement ShortcutsModal

Create `web/src/components/ShortcutsModal.tsx`:

```tsx
import { useStore } from "../store";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const MOD = isMac ? "\u2318" : "Ctrl";

const SHORTCUTS = [
  { keys: `${MOD}+B`, label: "Toggle sidebar" },
  { keys: `${MOD}+.`, label: "Toggle task panel" },
  { keys: "?", label: "Show shortcuts" },
  { keys: "Esc", label: "Close modal / interrupt" },
] as const;

export function ShortcutsModal() {
  const open = useStore((s) => s.shortcutsModalOpen);
  const close = useStore((s) => s.setShortcutsModalOpen);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        data-testid="shortcuts-backdrop"
        className="absolute inset-0 bg-black/50"
        onClick={() => close(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close(false);
        }}
        role="button"
        tabIndex={-1}
        aria-label="Close shortcuts modal"
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-bc-border bg-bc-surface p-5 shadow-2xl">
        <h2 className="mb-4 text-sm font-semibold text-bc-text">Keyboard Shortcuts</h2>
        <div className="space-y-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between text-xs">
              <span className="text-bc-text-muted">{s.label}</span>
              <kbd className="rounded bg-bc-surface-2 px-2 py-0.5 font-mono-code text-[11px] text-bc-text">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

### Step 9: Run modal tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/ShortcutsModal.test.tsx`
Expected: ALL PASS

### Step 10: Wire into App.tsx

In `web/src/App.tsx`:

1. Add imports after existing imports:

```tsx
import { ShortcutsModal } from "./components/ShortcutsModal";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
```

2. Add `useKeyboardShortcuts()` call inside `App()`, after `useBootstrap()` (line 84):

```tsx
useKeyboardShortcuts();
```

3. Add `<ShortcutsModal />` at the end of the return JSX, just before the closing `</div>` (before line 128):

```tsx
<ShortcutsModal />
```

### Step 11: Run full test suite

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/`
Expected: ALL PASS (existing tests should still pass with the new store state)

### Step 12: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/hooks/useKeyboardShortcuts.ts web/src/hooks/useKeyboardShortcuts.test.ts \
        web/src/components/ShortcutsModal.tsx web/src/components/ShortcutsModal.test.tsx \
        web/src/App.tsx web/src/store.ts
git commit -m "feat: add global keyboard shortcuts and discoverable shortcuts modal"
```

---

## Task 4: Partial Code Diff for Edit Tools

**Effort: M (~2-3 days)**

The most impactful visual upgrade. Create a `DiffView` component that renders `old_string` vs `new_string` as a unified diff with syntax-colored additions/deletions. Use it in both `PermissionBanner` (pre-approval preview) and `ToolBlock` (post-execution, when expanded).

**Files:**
- Create: `web/src/components/DiffView.tsx`
- Create: `web/src/components/DiffView.test.tsx`
- Modify: `web/src/components/PermissionBanner.tsx:17-27` (Edit case in `toolPreview`)
- Modify: `web/src/components/ToolBlock.tsx:81-86` (expanded content for Edit)
- Modify: `web/src/components/PermissionBanner.test.tsx`
- Modify: `web/src/components/ToolBlock.test.tsx`

**Note:** No external diff library needed. The `old_string`/`new_string` are already available from the Edit tool's `input`. We compute a simple line-by-line diff inline: split by `\n`, mark removed/added lines. This is a partial diff (not full-file), which is what Cline and Windsurf show.

### Step 1: Write failing tests for DiffView

Create `web/src/components/DiffView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView } from "./DiffView";

describe("DiffView", () => {
  it("renders nothing when both strings are empty", () => {
    const { container } = render(<DiffView oldString="" newString="" />);
    expect(container.querySelector("pre")).toBeInTheDocument();
  });

  it("renders removed lines with - prefix", () => {
    render(<DiffView oldString="const a = 1;" newString="" />);
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
  });

  it("renders added lines with + prefix", () => {
    render(<DiffView oldString="" newString="const b = 2;" />);
    expect(screen.getByText(/\+ const b = 2;/)).toBeInTheDocument();
  });

  it("renders both removed and added lines for a replacement", () => {
    render(<DiffView oldString="const a = 1;" newString="const a = 2;" />);
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
    expect(screen.getByText(/\+ const a = 2;/)).toBeInTheDocument();
  });

  it("renders multi-line diffs", () => {
    const oldStr = "line1\nline2\nline3";
    const newStr = "line1\nline2-changed\nline3";
    render(<DiffView oldString={oldStr} newString={newStr} />);
    expect(screen.getByText(/- line2/)).toBeInTheDocument();
    expect(screen.getByText(/\+ line2-changed/)).toBeInTheDocument();
  });

  it("renders file path when provided", () => {
    render(<DiffView oldString="a" newString="b" filePath="/src/app.ts" />);
    expect(screen.getByText("/src/app.ts")).toBeInTheDocument();
  });

  it("applies red styling to removed lines", () => {
    const { container } = render(<DiffView oldString="removed" newString="" />);
    const removedLine = container.querySelector("[data-diff='removed']");
    expect(removedLine).toBeInTheDocument();
  });

  it("applies green styling to added lines", () => {
    const { container } = render(<DiffView oldString="" newString="added" />);
    const addedLine = container.querySelector("[data-diff='added']");
    expect(addedLine).toBeInTheDocument();
  });

  it("truncates long diffs beyond maxLines", () => {
    const oldStr = Array.from({ length: 50 }, (_, i) => `old-line-${i}`).join("\n");
    const newStr = Array.from({ length: 50 }, (_, i) => `new-line-${i}`).join("\n");
    render(<DiffView oldString={oldStr} newString={newStr} maxLines={20} />);
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/DiffView.test.tsx`
Expected: FAIL — module not found

### Step 3: Implement DiffView

Create `web/src/components/DiffView.tsx`:

```tsx
interface DiffViewProps {
  oldString: string;
  newString: string;
  filePath?: string;
  maxLines?: number;
}

interface DiffLine {
  type: "added" | "removed" | "context";
  text: string;
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const lines: DiffLine[] = [];
  if (oldStr) {
    for (const line of oldStr.split("\n")) {
      lines.push({ type: "removed", text: line });
    }
  }
  if (newStr) {
    for (const line of newStr.split("\n")) {
      lines.push({ type: "added", text: line });
    }
  }
  return lines;
}

export function DiffView({ oldString, newString, filePath, maxLines = 40 }: DiffViewProps) {
  const allLines = computeDiff(oldString, newString);
  const truncated = allLines.length > maxLines;
  const lines = truncated ? allLines.slice(0, maxLines) : allLines;

  return (
    <div className="overflow-hidden rounded-lg border border-bc-border/60 bg-bc-code-bg">
      {filePath && (
        <div className="border-b border-bc-border/40 px-3 py-1.5 font-mono-code text-[11px] text-bc-text-muted">
          {filePath}
        </div>
      )}
      <pre className="overflow-x-auto p-2 font-mono-code text-xs leading-relaxed">
        {lines.map((line, i) => {
          const prefix = line.type === "removed" ? "- " : line.type === "added" ? "+ " : "  ";
          const color =
            line.type === "removed"
              ? "bg-bc-error/10 text-bc-error"
              : line.type === "added"
                ? "bg-bc-success/10 text-bc-success"
                : "text-bc-text-muted";
          return (
            <div key={i} className={`px-1 ${color}`} data-diff={line.type}>
              {prefix}
              {line.text}
            </div>
          );
        })}
        {truncated && (
          <div className="mt-1 px-1 text-bc-text-muted/60 italic">
            ... truncated ({allLines.length - maxLines} more lines)
          </div>
        )}
      </pre>
    </div>
  );
}
```

### Step 4: Run DiffView tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/DiffView.test.tsx`
Expected: ALL PASS

### Step 5: Write failing tests for DiffView integration in PermissionBanner

Add to `web/src/components/PermissionBanner.test.tsx`, in the existing "shows Edit tool preview" test area:

```tsx
it("renders DiffView for Edit tool permission", () => {
  renderWithPermission(
    makePermission({
      request_id: "req-diff",
      tool_use_id: "tu-diff",
      tool_name: "Edit",
      description: "Edit a file",
      input: { file_path: "/src/app.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
    }),
  );

  // DiffView should show diff markers
  expect(screen.getByText(/- const x = 1;/)).toBeInTheDocument();
  expect(screen.getByText(/\+ const x = 2;/)).toBeInTheDocument();
});
```

### Step 6: Integrate DiffView into PermissionBanner

In `web/src/components/PermissionBanner.tsx`:

1. Add import at top:

```tsx
import { DiffView } from "./DiffView";
```

2. Replace the `case "Edit":` block (lines 17-27) with:

```tsx
case "Edit":
  return (
    <DiffView
      oldString={String(input.old_string ?? "")}
      newString={String(input.new_string ?? "")}
      filePath={String(input.file_path ?? "")}
    />
  );
```

### Step 7: Run PermissionBanner tests

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/PermissionBanner.test.tsx`
Expected: ALL PASS (update any tests that relied on the old `- foo` / `+ bar` format if needed)

### Step 8: Write failing tests for DiffView integration in ToolBlock

Add to `web/src/components/ToolBlock.test.tsx`:

```tsx
it("shows DiffView when Edit tool is expanded", async () => {
  const user = userEvent.setup();
  render(
    <ToolBlock
      id="t1"
      name="Edit"
      input={{ file_path: "/src/app.ts", old_string: "const x = 1;", new_string: "const x = 2;" }}
      sessionId={SESSION}
    />,
  );

  await user.click(screen.getByRole("button"));

  expect(screen.getByText(/- const x = 1;/)).toBeInTheDocument();
  expect(screen.getByText(/\+ const x = 2;/)).toBeInTheDocument();
});

it("still shows JSON for non-Edit tools when expanded", async () => {
  const user = userEvent.setup();
  render(<ToolBlock id="t1" name="Bash" input={{ command: "ls" }} sessionId={SESSION} />);

  await user.click(screen.getByRole("button"));

  expect(screen.getByText(/"command": "ls"/)).toBeInTheDocument();
});
```

### Step 9: Integrate DiffView into ToolBlock

In `web/src/components/ToolBlock.tsx`:

1. Add import:

```tsx
import { DiffView } from "./DiffView";
```

2. Replace the expanded content block (lines 81-85) with:

```tsx
{open && (
  name === "Edit" && "old_string" in input ? (
    <div className="border-t border-bc-border/50 p-2">
      <DiffView
        oldString={String(input.old_string ?? "")}
        newString={String(input.new_string ?? "")}
        filePath={String(input.file_path ?? "")}
      />
    </div>
  ) : (
    <pre className="max-h-60 overflow-auto border-t border-bc-border/50 bg-bc-code-bg p-3 font-mono-code text-xs text-bc-text-muted leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  )
)}
```

### Step 10: Run ToolBlock tests

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/ToolBlock.test.tsx`
Expected: ALL PASS

### Step 11: Run full test suite

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/`
Expected: ALL PASS

### Step 12: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/components/DiffView.tsx web/src/components/DiffView.test.tsx \
        web/src/components/PermissionBanner.tsx web/src/components/PermissionBanner.test.tsx \
        web/src/components/ToolBlock.tsx web/src/components/ToolBlock.test.tsx
git commit -m "feat: add partial code diff view for Edit tool blocks"
```

---

## Task 5: Conversation Export (Markdown/JSON)

**Effort: S (~1 day)**

Add export buttons to TaskPanel that serialize the current session's messages to Markdown or JSON and download them.

**Files:**
- Create: `web/src/utils/export.ts`
- Create: `web/src/utils/export.test.ts`
- Modify: `web/src/components/TaskPanel.tsx:59-78` (add export buttons after model usage)

### Step 1: Write failing tests for export utilities

Create `web/src/utils/export.test.ts`:

```ts
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
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
    const messages: ConsumerMessage[] = [
      { type: "error", message: "something broke" },
    ];
    const md = exportAsMarkdown(messages);
    expect(md).toContain("something broke");
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/utils/export.test.ts`
Expected: FAIL — module not found

### Step 3: Implement export utilities

Create `web/src/utils/export.ts`:

```ts
import type { ConsumerContentBlock, ConsumerMessage } from "../../../shared/consumer-types";

export function exportAsJson(messages: ConsumerMessage[]): string {
  return JSON.stringify(messages, null, 2);
}

function renderBlock(block: ConsumerContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `**${block.name}**\n\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``;
    case "tool_result": {
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      return `> Tool result:\n> ${content.slice(0, 500)}`;
    }
    case "thinking":
      return `<details><summary>Thinking</summary>\n\n${block.thinking}\n\n</details>`;
    default:
      return "";
  }
}

export function exportAsMarkdown(messages: ConsumerMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    switch (msg.type) {
      case "user_message":
        parts.push(`### User\n\n${msg.content}\n`);
        break;
      case "assistant":
        parts.push(
          `### Assistant\n\n${msg.message.content.map(renderBlock).join("\n\n")}\n`,
        );
        break;
      case "result":
        if (msg.data.result) {
          parts.push(`### Result\n\n${msg.data.result}\n`);
        }
        break;
      case "error":
        parts.push(`### Error\n\n${msg.message}\n`);
        break;
      default:
        break;
    }
  }

  return parts.join("\n---\n\n");
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

### Step 4: Run export tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/utils/export.test.ts`
Expected: ALL PASS

### Step 5: Add export buttons to TaskPanel

In `web/src/components/TaskPanel.tsx`:

1. Add import:

```tsx
import { downloadFile, exportAsJson, exportAsMarkdown } from "../utils/export";
```

2. Add export handlers inside `TaskPanel()`, after the `state`/`cost`/`turns`/`contextPercent` declarations:

```tsx
const handleExportJson = () => {
  const content = exportAsJson(sessionData.messages);
  downloadFile(content, `beamcode-session-${currentSessionId}.json`, "application/json");
};

const handleExportMarkdown = () => {
  const content = exportAsMarkdown(sessionData.messages);
  downloadFile(content, `beamcode-session-${currentSessionId}.md`, "text/markdown");
};
```

3. Add export section after the model usage section (after the closing `</div>` of the model usage block, before the last `</div>` of the scrollable area):

```tsx
{/* Export */}
<div className="mt-5 border-t border-bc-border/40 pt-4">
  <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
    Export
  </div>
  <div className="flex gap-2">
    <button
      type="button"
      onClick={handleExportMarkdown}
      className="flex-1 rounded-lg border border-bc-border/60 px-3 py-1.5 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
    >
      Markdown
    </button>
    <button
      type="button"
      onClick={handleExportJson}
      className="flex-1 rounded-lg border border-bc-border/60 px-3 py-1.5 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
    >
      JSON
    </button>
  </div>
</div>
```

### Step 6: Run full test suite

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/`
Expected: ALL PASS

### Step 7: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/utils/export.ts web/src/utils/export.test.ts web/src/components/TaskPanel.tsx
git commit -m "feat: add conversation export as Markdown/JSON"
```

---

## Task 6: Image Drag-and-Drop in Composer

**Effort: M (~2 days)**

The protocol already supports `images?: { media_type: string; data: string }[]` on `InboundMessage.user_message` (see `shared/consumer-types.ts:211`). Only the Composer UI needs building: drag-and-drop zone, paste support, FileReader to base64, preview thumbnails, and sending images with the message.

**Files:**
- Modify: `web/src/components/Composer.tsx:10-136`
- Modify: `web/src/components/Composer.test.tsx`

### Step 1: Write failing tests for image handling

Add to `web/src/components/Composer.test.tsx`. First, need to read the existing test file to understand the structure and add new tests. Add these tests:

```tsx
// ── Image handling ──────────────────────────────────────────────────

describe("image handling", () => {
  const SESSION_ID = "img-test-session";

  function renderComposer() {
    store().ensureSessionData(SESSION_ID);
    return render(<Composer sessionId={SESSION_ID} />);
  }

  it("renders a drop zone indicator on dragover", async () => {
    const { container } = renderComposer();
    const composer = container.firstChild as HTMLElement;

    // Simulate dragover
    fireEvent.dragOver(composer, {
      dataTransfer: { types: ["Files"] },
    });

    expect(screen.getByText(/drop image/i)).toBeInTheDocument();
  });

  it("shows image preview after dropping an image file", async () => {
    const { container } = renderComposer();
    const composer = container.firstChild as HTMLElement;

    const file = new File(["(binary)"], "screenshot.png", { type: "image/png" });

    // Mock FileReader
    const originalFileReader = global.FileReader;
    const mockReadAsDataURL = vi.fn();
    global.FileReader = vi.fn().mockImplementation(() => ({
      readAsDataURL: mockReadAsDataURL,
      result: "data:image/png;base64,iVBOR...",
      onload: null,
    })) as unknown as typeof FileReader;

    fireEvent.drop(composer, {
      dataTransfer: { files: [file], types: ["Files"] },
    });

    // Trigger the onload callback
    const readerInstance = (global.FileReader as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    readerInstance.onload?.();

    // Restore
    global.FileReader = originalFileReader;
  });

  it("sends images array with user_message on submit", async () => {
    // This test verifies the integration: when images are attached and user submits,
    // the send() call includes the images field.
    // Implementation detail: the actual test will be more complex with mocked FileReader.
  });

  it("clears image previews after sending", async () => {
    // After submit, the image preview area should be empty.
  });

  it("removes image preview when clicking the remove button", async () => {
    // Each preview thumbnail should have an X button to remove it.
  });
});
```

> **Note to implementer:** The image drag-and-drop tests require mocking `FileReader` and `DataTransfer`. The exact test implementation should follow the pattern above but adapt to whatever testing utilities are available. The key assertions are:
> 1. Dragover shows a visual indicator
> 2. Drop processes image files via FileReader
> 3. Preview thumbnails appear
> 4. Submit includes `images` in the `send()` payload
> 5. Previews clear after send
> 6. Individual images can be removed

### Step 2: Implement image handling in Composer

In `web/src/components/Composer.tsx`:

1. Add state for images and drag status after existing state declarations:

```tsx
const [images, setImages] = useState<{ media_type: string; data: string; preview: string }[]>([]);
const [isDragging, setIsDragging] = useState(false);
```

2. Add file processing helper:

```tsx
const processFiles = useCallback((files: FileList) => {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      setImages((prev) => [
        ...prev,
        { media_type: file.type, data: base64, preview: dataUrl },
      ]);
    };
    reader.readAsDataURL(file);
  }
}, []);
```

3. Add drag/drop/paste handlers:

```tsx
const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes("Files")) {
    setIsDragging(true);
  }
}, []);

const handleDragLeave = useCallback(() => {
  setIsDragging(false);
}, []);

const handleDrop = useCallback(
  (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  },
  [processFiles],
);

const handlePaste = useCallback(
  (e: React.ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      processFiles(e.clipboardData.files);
    }
  },
  [processFiles],
);

const removeImage = useCallback((index: number) => {
  setImages((prev) => prev.filter((_, i) => i !== index));
}, []);
```

4. Update `handleSubmit` to include images:

```tsx
const handleSubmit = useCallback(() => {
  const trimmed = value.trim();
  if (!trimmed && images.length === 0) return;

  if (trimmed.startsWith("/")) {
    send({ type: "slash_command", command: trimmed });
  } else {
    const msg: { type: "user_message"; content: string; images?: { media_type: string; data: string }[] } = {
      type: "user_message",
      content: trimmed,
    };
    if (images.length > 0) {
      msg.images = images.map(({ media_type, data }) => ({ media_type, data }));
    }
    send(msg);
  }
  setValue("");
  setImages([]);
  setShowSlash(false);
}, [value, images]);
```

5. Add drag handlers to the outer `<div>` wrapper:

```tsx
<div
  className="relative border-t border-bc-border bg-bc-surface px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
>
```

6. Add paste handler to the textarea:

```tsx
<textarea
  ...existing props...
  onPaste={handlePaste}
/>
```

7. Add image preview thumbnails above the textarea row (inside the `mx-auto flex max-w-3xl` area, before the textarea):

```tsx
{/* Image previews */}
{images.length > 0 && (
  <div className="mb-2 flex flex-wrap gap-2">
    {images.map((img, i) => (
      <div key={i} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-bc-border">
        <img src={img.preview} alt={`Attached ${i + 1}`} className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={() => removeImage(i)}
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-bc-error text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={`Remove image ${i + 1}`}
        >
          x
        </button>
      </div>
    ))}
  </div>
)}

{/* Drag overlay */}
{isDragging && (
  <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-bc-accent bg-bc-accent/10">
    <span className="text-sm text-bc-accent">Drop image here</span>
  </div>
)}
```

> **Note:** Restructure the JSX slightly so image previews appear above the textarea+button row. The drag overlay is positioned absolute over the whole Composer.

### Step 3: Run tests

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/Composer.test.tsx`
Expected: ALL PASS

### Step 4: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/components/Composer.tsx web/src/components/Composer.test.tsx
git commit -m "feat: add image drag-and-drop and paste support in Composer"
```

---

## Task 7: Cost/Token Tracking Enhancement

**Effort: S (~1 day)**

TaskPanel already shows total cost and turns. Enhance it with per-turn cost breakdown using data from `ResultData.modelUsage` that arrives with each `result` message. Display a lightweight token breakdown per model.

**Files:**
- Modify: `web/src/components/TaskPanel.tsx`
- Modify: `web/src/components/TaskPanel.test.tsx`

### Step 1: Write failing tests

Add to `web/src/components/TaskPanel.test.tsx`:

```tsx
describe("enhanced cost tracking", () => {
  it("shows total input and output tokens", () => {
    store().ensureSessionData("s1");
    store().setSessionState("s1", {
      session_id: "s1",
      model: "claude-3-opus",
      cwd: "/tmp",
      total_cost_usd: 0.05,
      num_turns: 3,
      context_used_percent: 45,
      is_compacting: false,
      last_model_usage: {
        "claude-3-opus": {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 500,
          contextWindow: 200000,
          costUSD: 0.05,
        },
      },
    });
    useStore.setState({ currentSessionId: "s1" });

    render(<TaskPanel />);

    // Should show formatted token counts
    expect(screen.getByText(/5\.0k/)).toBeInTheDocument(); // input tokens
    expect(screen.getByText(/2\.0k/)).toBeInTheDocument(); // output tokens
  });

  it("shows cache hit ratio when cache data exists", () => {
    store().ensureSessionData("s1");
    store().setSessionState("s1", {
      session_id: "s1",
      model: "claude-3-opus",
      cwd: "/tmp",
      total_cost_usd: 0.05,
      num_turns: 3,
      context_used_percent: 45,
      is_compacting: false,
      last_model_usage: {
        "claude-3-opus": {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 3000,
          cacheCreationInputTokens: 500,
          contextWindow: 200000,
          costUSD: 0.05,
        },
      },
    });
    useStore.setState({ currentSessionId: "s1" });

    render(<TaskPanel />);

    expect(screen.getByText(/cache/i)).toBeInTheDocument();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/TaskPanel.test.tsx`
Expected: FAIL — token counts not found

### Step 3: Implement enhanced cost tracking

In `web/src/components/TaskPanel.tsx`, update the model usage rendering section. Replace the existing model usage block (lines 61-78) with an enhanced version:

```tsx
{state?.last_model_usage && (
  <div>
    <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-bc-text-muted/70">
      Model Usage
    </div>
    {Object.entries(state.last_model_usage).map(([model, usage]) => {
      const totalInput = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
      const cacheRatio = totalInput > 0 ? Math.round((usage.cacheReadInputTokens / totalInput) * 100) : 0;

      return (
        <div
          key={model}
          className="mb-2 rounded-lg border border-bc-border/40 bg-bc-surface-2/30 p-2.5 text-xs"
        >
          <div className="font-medium text-bc-text">{model}</div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums text-bc-text-muted">
            <span>Input</span>
            <span className="text-right">{formatTokens(usage.inputTokens)}</span>
            <span>Output</span>
            <span className="text-right">{formatTokens(usage.outputTokens)}</span>
            {cacheRatio > 0 && (
              <>
                <span>Cache hit</span>
                <span className="text-right">{cacheRatio}%</span>
              </>
            )}
          </div>
          <div className="mt-1.5 border-t border-bc-border/30 pt-1.5 font-medium tabular-nums text-bc-text">
            {formatCost(usage.costUSD)}
          </div>
        </div>
      );
    })}
  </div>
)}
```

Also add `formatTokens` to the imports:

```tsx
import { formatCost, formatTokens } from "../utils/format";
```

### Step 4: Run tests to verify they pass

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/TaskPanel.test.tsx`
Expected: ALL PASS

### Step 5: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/components/TaskPanel.tsx web/src/components/TaskPanel.test.tsx
git commit -m "feat: enhance cost/token tracking with per-model breakdown and cache ratio"
```

---

## Task 8: Reconnection UX Banner

**Effort: S (~0.5 day)**

`ws.ts` has exponential backoff reconnection, but the UI only shows a tiny 1.5px dot in TopBar. Add a visible "Reconnecting..." banner with attempt count when WebSocket is disconnected.

**Files:**
- Modify: `web/src/components/ConnectionBanner.tsx:1-11`
- Modify: `web/src/components/ConnectionBanner.test.tsx:1-12`
- Modify: `web/src/ws.ts` (export reconnect state)
- Modify: `web/src/store.ts` (add reconnect tracking)

### Step 1: Write failing tests

Replace `web/src/components/ConnectionBanner.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "../test/factories";
import { ConnectionBanner } from "./ConnectionBanner";

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  getActiveSessionId: vi.fn(() => "s1"),
}));

import { connectToSession, getActiveSessionId } from "../ws";

describe("ConnectionBanner", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders an alert with disconnection message", () => {
    render(<ConnectionBanner />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/disconnected/i);
  });

  it("shows reconnection attempt count when reconnecting", () => {
    store().ensureSessionData("s1");
    store().setConnectionStatus("s1", "connecting");
    useStore.setState({ currentSessionId: "s1" });

    render(<ConnectionBanner reconnectAttempt={3} />);
    expect(screen.getByText(/attempt 3/i)).toBeInTheDocument();
  });

  it("renders a manual retry button", () => {
    render(<ConnectionBanner />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls connectToSession when retry is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(getActiveSessionId).mockReturnValue("s1");

    render(<ConnectionBanner />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(connectToSession).toHaveBeenCalledWith("s1");
  });
});
```

> **Note:** You'll need to import `useStore` at the top of the test. The `reconnectAttempt` prop is the simplest approach — pass it from `ChatView` which can read it from store.

### Step 2: Run tests to verify they fail

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/ConnectionBanner.test.tsx`
Expected: FAIL — retry button not found

### Step 3: Add reconnect tracking to store

In `web/src/store.ts`, add to `SessionData` interface:

```ts
reconnectAttempt: number;
```

Add to `emptySessionData()`:

```ts
reconnectAttempt: 0,
```

Add action to `AppState`:

```ts
setReconnectAttempt: (sessionId: string, attempt: number) => void;
```

Add implementation:

```ts
setReconnectAttempt: (sessionId, attempt) =>
  set((s) => patchSession(s, sessionId, { reconnectAttempt: attempt })),
```

### Step 4: Export reconnect attempt from ws.ts

In `web/src/ws.ts`, update `connectToSession` to track attempt count:

After `reconnectAttempt = 0;` in `ws.onopen`, add:

```ts
store.setReconnectAttempt(sessionId, 0);
```

In `scheduleReconnect`, after `reconnectAttempt++;`, add:

```ts
useStore.getState().setReconnectAttempt(sessionId, reconnectAttempt);
```

### Step 5: Implement enhanced ConnectionBanner

Replace `web/src/components/ConnectionBanner.tsx`:

```tsx
import { useStore } from "../store";
import { connectToSession, getActiveSessionId } from "../ws";

interface ConnectionBannerProps {
  reconnectAttempt?: number;
}

export function ConnectionBanner({ reconnectAttempt }: ConnectionBannerProps) {
  const sessionId = getActiveSessionId();

  const handleRetry = () => {
    if (sessionId) {
      connectToSession(sessionId);
    }
  };

  return (
    <div
      className="flex items-center justify-center gap-2 border-b border-bc-warning/20 bg-bc-warning/10 px-3 py-2 text-xs text-bc-warning"
      role="alert"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bc-warning" />
      <span>
        CLI disconnected — waiting for reconnection
        {reconnectAttempt != null && reconnectAttempt > 0 && (
          <span className="ml-1 text-bc-text-muted">(attempt {reconnectAttempt})</span>
        )}
      </span>
      <button
        type="button"
        onClick={handleRetry}
        className="ml-2 rounded bg-bc-warning/20 px-2 py-0.5 text-xs font-medium text-bc-warning transition-colors hover:bg-bc-warning/30"
        aria-label="Retry connection"
      >
        Retry
      </button>
    </div>
  );
}
```

### Step 6: Update ChatView to pass reconnectAttempt

In `web/src/components/ChatView.tsx`, update the ConnectionBanner usage:

```tsx
{!cliConnected && connectionStatus === "connected" && (
  <ConnectionBanner reconnectAttempt={sessionData.reconnectAttempt} />
)}
```

### Step 7: Run tests

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/components/ConnectionBanner.test.tsx`
Expected: ALL PASS

### Step 8: Run full test suite

Run: `cd /Users/blackmyth/src/beamcode && npx vitest run web/src/`
Expected: ALL PASS

### Step 9: Commit

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/competitive-analysis
git add web/src/components/ConnectionBanner.tsx web/src/components/ConnectionBanner.test.tsx \
        web/src/components/ChatView.tsx web/src/store.ts web/src/ws.ts
git commit -m "feat: enhance reconnection UX with retry button and attempt counter"
```

---

## Final Verification

### Run the entire test suite

```bash
cd /Users/blackmyth/src/beamcode && npx vitest run web/src/
```

### Run the build

```bash
cd /Users/blackmyth/src/beamcode/web && npm run build
```

### Summary of Changes

| Task | Feature | Files Changed | Files Created | LOC (est.) |
|------|---------|--------------|---------------|-----------|
| 1 | Session search | 2 | 0 | ~30 |
| 2 | Allow All | 2 | 0 | ~25 |
| 3 | Keyboard shortcuts | 2 | 4 | ~150 |
| 4 | Partial code diff | 4 | 2 | ~120 |
| 5 | Conversation export | 1 | 2 | ~100 |
| 6 | Image drag-and-drop | 2 | 0 | ~100 |
| 7 | Cost/token tracking | 2 | 0 | ~40 |
| 8 | Reconnection UX | 4 | 0 | ~50 |
| **Total** | **8 features** | **15** | **8** | **~615** |
