import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumerPermissionRequest } from "../../../shared/consumer-types";
import { makePermission, resetStore, store } from "../test/factories";
import * as ws from "../ws";
import { PermissionBanner } from "./PermissionBanner";

vi.mock("../ws", () => ({
  send: vi.fn(),
}));

const SESSION_ID = "perm-test-session";

function renderWithPermission(
  ...permissions: ConsumerPermissionRequest[]
): ReturnType<typeof render> {
  store().ensureSessionData(SESSION_ID);
  for (const perm of permissions) {
    store().addPermission(SESSION_ID, perm);
  }
  return render(<PermissionBanner sessionId={SESSION_ID} />);
}

describe("PermissionBanner", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders nothing when no permissions pending", () => {
    store().ensureSessionData(SESSION_ID);
    const { container } = render(<PermissionBanner sessionId={SESSION_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when session data does not exist", () => {
    const { container } = render(<PermissionBanner sessionId="nonexistent" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders permission request with tool name", () => {
    renderWithPermission(makePermission());

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Run a command")).toBeInTheDocument();
  });

  it("shows Bash command preview", () => {
    renderWithPermission(makePermission());

    expect(screen.getByText("$ ls")).toBeInTheDocument();
  });

  it("shows Edit tool preview with old/new strings", () => {
    renderWithPermission(
      makePermission({
        request_id: "req-2",
        tool_use_id: "tu-2",
        tool_name: "Edit",
        description: "Edit a file",
        input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
      }),
    );

    expect(screen.getByText("/tmp/test.ts")).toBeInTheDocument();
    expect(screen.getByText(/foo/)).toBeInTheDocument();
    expect(screen.getByText(/bar/)).toBeInTheDocument();
  });

  it("sends allow response and removes permission on Allow click", async () => {
    const user = userEvent.setup();
    renderWithPermission(makePermission({ request_id: "req-1" }));

    await user.click(screen.getByRole("button", { name: /approve bash/i }));

    expect(ws.send).toHaveBeenCalledWith(
      { type: "permission_response", request_id: "req-1", behavior: "allow" },
      SESSION_ID,
    );
    expect(store().sessionData[SESSION_ID].pendingPermissions["req-1"]).toBeUndefined();
  });

  it("sends deny response and removes permission on Deny click", async () => {
    const user = userEvent.setup();
    renderWithPermission(makePermission({ request_id: "req-1" }));

    await user.click(screen.getByRole("button", { name: /deny bash/i }));

    expect(ws.send).toHaveBeenCalledWith(
      { type: "permission_response", request_id: "req-1", behavior: "deny" },
      SESSION_ID,
    );
    expect(store().sessionData[SESSION_ID].pendingPermissions["req-1"]).toBeUndefined();
  });

  it("renders multiple permission requests", () => {
    renderWithPermission(
      makePermission(),
      makePermission({
        request_id: "req-2",
        tool_use_id: "tu-2",
        tool_name: "Edit",
        description: "Edit a file",
        input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
      }),
    );

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

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

    expect(screen.getByText(/- const x = 1;/)).toBeInTheDocument();
    expect(screen.getByText(/\+ const x = 2;/)).toBeInTheDocument();
  });

  // ── Write tool preview ─────────────────────────────────────────────────

  describe("Write tool preview", () => {
    it("renders file path and content preview", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-write",
          tool_use_id: "tu-write",
          tool_name: "Write",
          description: "Write a file",
          input: { file_path: "/tmp/output.ts", content: "export const x = 42;" },
        }),
      );

      expect(screen.getByText("Write")).toBeInTheDocument();
      expect(screen.getByText("/tmp/output.ts")).toBeInTheDocument();
      expect(screen.getByText("export const x = 42;")).toBeInTheDocument();
    });

    it("renders file path without content when content is missing", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-write2",
          tool_use_id: "tu-write2",
          tool_name: "Write",
          description: "Write a file",
          input: { file_path: "/tmp/empty.ts" },
        }),
      );

      expect(screen.getByText("/tmp/empty.ts")).toBeInTheDocument();
    });
  });

  // ── Read / Glob / Grep tool previews ───────────────────────────────────

  describe("Read/Glob/Grep tool preview", () => {
    it("renders Read tool with file_path", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-read",
          tool_use_id: "tu-read",
          tool_name: "Read",
          description: "Read a file",
          input: { file_path: "/tmp/readme.md" },
        }),
      );

      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText(/\/tmp\/readme\.md/)).toBeInTheDocument();
    });

    it("renders Glob tool with pattern and path", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-glob",
          tool_use_id: "tu-glob",
          tool_name: "Glob",
          description: "Search files",
          input: { pattern: "**/*.ts", path: "/src" },
        }),
      );

      expect(screen.getByText("Glob")).toBeInTheDocument();
      expect(screen.getByText(/\*\*\/\*\.ts/)).toBeInTheDocument();
      expect(screen.getByText(/in \/src/)).toBeInTheDocument();
    });

    it("renders Grep tool with pattern and file_path", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-grep",
          tool_use_id: "tu-grep",
          tool_name: "Grep",
          description: "Search content",
          input: { pattern: "TODO", file_path: "/src/app.ts" },
        }),
      );

      expect(screen.getByText("Grep")).toBeInTheDocument();
      expect(screen.getByText(/TODO/)).toBeInTheDocument();
      expect(screen.getByText(/\/src\/app\.ts/)).toBeInTheDocument();
    });
  });

  // ── Default tool preview ───────────────────────────────────────────────

  describe("default tool preview", () => {
    it("renders JSON fallback for unknown tool", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-unknown",
          tool_use_id: "tu-unknown",
          tool_name: "CustomTool",
          description: "Custom operation",
          input: { foo: "bar", baz: 123 },
        }),
      );

      expect(screen.getByText("CustomTool")).toBeInTheDocument();
      // JSON.stringify output should be in a <pre>
      expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
    });
  });

  // ── Allow All ───────────────────────────────────────────────────────

  describe("Allow All", () => {
    it("does not show Allow All when only one permission is pending", () => {
      renderWithPermission(makePermission());
      expect(screen.queryByRole("button", { name: /allow all/i })).not.toBeInTheDocument();
    });

    it("shows Allow All button when multiple permissions are pending", () => {
      renderWithPermission(
        makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
        makePermission({
          request_id: "req-2",
          tool_use_id: "tu-2",
          tool_name: "Edit",
          input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" },
        }),
      );
      expect(screen.getByRole("button", { name: /allow all/i })).toBeInTheDocument();
    });

    it("sends allow response for all permissions when clicked", async () => {
      const user = userEvent.setup();
      renderWithPermission(
        makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
        makePermission({
          request_id: "req-2",
          tool_use_id: "tu-2",
          tool_name: "Edit",
          input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" },
        }),
        makePermission({
          request_id: "req-3",
          tool_use_id: "tu-3",
          tool_name: "Write",
          input: { file_path: "/tmp/b.ts", content: "x" },
        }),
      );

      await user.click(screen.getByRole("button", { name: /allow all/i }));

      expect(ws.send).toHaveBeenCalledTimes(3);
      expect(ws.send).toHaveBeenCalledWith(
        { type: "permission_response", request_id: "req-1", behavior: "allow" },
        SESSION_ID,
      );
      expect(ws.send).toHaveBeenCalledWith(
        { type: "permission_response", request_id: "req-2", behavior: "allow" },
        SESSION_ID,
      );
      expect(ws.send).toHaveBeenCalledWith(
        { type: "permission_response", request_id: "req-3", behavior: "allow" },
        SESSION_ID,
      );
    });

    it("removes all permissions from store after Allow All", async () => {
      const user = userEvent.setup();
      renderWithPermission(
        makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
        makePermission({
          request_id: "req-2",
          tool_use_id: "tu-2",
          tool_name: "Edit",
          input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" },
        }),
      );

      await user.click(screen.getByRole("button", { name: /allow all/i }));

      const perms = store().sessionData[SESSION_ID].pendingPermissions;
      expect(Object.keys(perms)).toHaveLength(0);
    });
  });

  // ── Observer mode ──────────────────────────────────────────────────────

  describe("observer mode", () => {
    it("hides Allow/Deny buttons when identity role is observer", () => {
      store().setIdentity(SESSION_ID, { userId: "u1", displayName: "Bob", role: "observer" });
      renderWithPermission(makePermission());

      expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /deny/i })).not.toBeInTheDocument();
    });

    it("hides Allow All when observer with multiple permissions", () => {
      store().setIdentity(SESSION_ID, { userId: "u1", displayName: "Bob", role: "observer" });
      renderWithPermission(
        makePermission({ request_id: "req-1", tool_use_id: "tu-1" }),
        makePermission({
          request_id: "req-2",
          tool_use_id: "tu-2",
          tool_name: "Edit",
          input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" },
        }),
      );

      expect(screen.queryByRole("button", { name: /allow all/i })).not.toBeInTheDocument();
    });

    it("still shows permission previews for observers (read-only view)", () => {
      store().setIdentity(SESSION_ID, { userId: "u1", displayName: "Bob", role: "observer" });
      renderWithPermission(makePermission({ tool_name: "Bash", input: { command: "echo hi" } }));

      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("$ echo hi")).toBeInTheDocument();
    });

    it("shows buttons when role is participant", () => {
      store().setIdentity(SESSION_ID, { userId: "u1", displayName: "Alice", role: "participant" });
      renderWithPermission(makePermission());

      expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
    });
  });

  // ── Permission without description ─────────────────────────────────────

  describe("permission without description", () => {
    it("renders permission without description text", () => {
      renderWithPermission(
        makePermission({
          request_id: "req-nodesc",
          tool_use_id: "tu-nodesc",
          tool_name: "Bash",
          description: "",
          input: { command: "echo hello" },
        }),
      );

      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("$ echo hello")).toBeInTheDocument();
      // When description is empty, no description text should appear
      expect(screen.queryByText("Run a command")).not.toBeInTheDocument();
    });
  });
});
