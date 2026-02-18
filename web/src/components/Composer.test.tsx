import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkA11y } from "../test/a11y";
import { resetStore, store } from "../test/factories";
import { Composer } from "./Composer";

vi.mock("../ws", () => ({ send: vi.fn() }));
vi.mock("./SlashMenu", () => ({
  SlashMenu: () => null,
}));

import { send } from "../ws";

const SESSION = "composer-test";

describe("Composer", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('renders textarea with "Message BeamCode..." placeholder', () => {
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);
    expect(screen.getByPlaceholderText("Message BeamCode...")).toBeInTheDocument();
  });

  it("renders disabled send button when input is empty", () => {
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("enables send button when text is entered", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    await user.type(screen.getByLabelText("Message input"), "hello");
    expect(screen.getByLabelText("Send message")).toBeEnabled();
  });

  it("sends user_message on Enter key", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "hello{Enter}");

    expect(send).toHaveBeenCalledWith({ type: "user_message", content: "hello" }, SESSION);
  });

  it("optimistically sets sessionStatus to running after sending user_message", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "hello{Enter}");

    expect(store().sessionData[SESSION]?.sessionStatus).toBe("running");
  });

  it('sends slash_command when input starts with "/"', async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "/help{Enter}");

    expect(send).toHaveBeenCalledWith({ type: "slash_command", command: "/help" }, SESSION);
  });

  it("clears input after sending", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "hello{Enter}");

    expect(textarea).toHaveValue("");
  });

  it("shows send button (queue mode) when session is running without a queued message", () => {
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("shows interrupt button when session is running and a message is queued", () => {
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    store().setIdentity(SESSION, { userId: "u1", displayName: "User 1", role: "participant" });
    store().setQueuedMessage(SESSION, {
      consumerId: "u1",
      displayName: "User 1",
      content: "queued text",
      queuedAt: Date.now(),
    });
    render(<Composer sessionId={SESSION} />);

    expect(screen.getByLabelText("Interrupt")).toBeInTheDocument();
  });

  it("sends interrupt on Enter when running", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "{Enter}");

    expect(send).toHaveBeenCalledWith({ type: "interrupt" }, SESSION);
  });

  it("sends interrupt on Escape when running", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "{Escape}");

    expect(send).toHaveBeenCalledWith({ type: "interrupt" }, SESSION);
  });

  // ── Image handling ──────────────────────────────────────────────────

  describe("image handling", () => {
    function renderComposer() {
      store().ensureSessionData(SESSION);
      return render(<Composer sessionId={SESSION} />);
    }

    /** Create a mock FileReader that captures onload and exposes it for triggering. */
    function mockFileReader(dataUrl: string) {
      const original = global.FileReader;
      let capturedOnload: (() => void) | null = null;

      // Must use function (not arrow) so it works with `new`
      function MockReader(this: {
        readAsDataURL: ReturnType<typeof vi.fn>;
        result: string;
        onload: (() => void) | null;
      }) {
        this.readAsDataURL = vi.fn();
        this.result = dataUrl;
        this.onload = null;

        Object.defineProperty(this, "onload", {
          set(fn: (() => void) | null) {
            capturedOnload = fn;
          },
          get() {
            return capturedOnload;
          },
        });
      }

      global.FileReader = MockReader as unknown as typeof FileReader;

      return {
        triggerOnload: () => capturedOnload?.(),
        restore: () => {
          global.FileReader = original;
        },
      };
    }

    it("renders a drop zone indicator on dragover", () => {
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      fireEvent.dragOver(composer, {
        dataTransfer: { types: ["Files"] },
      });

      expect(screen.getByText(/drop image/i)).toBeInTheDocument();
    });

    it("hides drop zone on dragleave", () => {
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      fireEvent.dragOver(composer, {
        dataTransfer: { types: ["Files"] },
      });
      expect(screen.getByText(/drop image/i)).toBeInTheDocument();

      fireEvent.dragLeave(composer);
      expect(screen.queryByText(/drop image/i)).not.toBeInTheDocument();
    });

    it("shows image preview after dropping an image file", () => {
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      const file = new File(["(binary)"], "screenshot.png", { type: "image/png" });
      const mock = mockFileReader("data:image/png;base64,iVBOR");

      fireEvent.drop(composer, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
      act(() => mock.triggerOnload());
      mock.restore();

      expect(screen.getByAltText("Attached 1")).toBeInTheDocument();
    });

    it("ignores non-image files on drop", () => {
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      const file = new File(["text"], "readme.txt", { type: "text/plain" });
      const mock = mockFileReader("data:text/plain;base64,dGV4dA==");

      fireEvent.drop(composer, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
      mock.restore();

      expect(screen.queryByAltText(/Attached/)).not.toBeInTheDocument();
    });

    it("removes image preview when clicking the remove button", () => {
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      const file = new File(["(binary)"], "photo.jpg", { type: "image/jpeg" });
      const mock = mockFileReader("data:image/jpeg;base64,/9j/4");

      fireEvent.drop(composer, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
      act(() => mock.triggerOnload());
      mock.restore();

      expect(screen.getByAltText("Attached 1")).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText("Remove image 1"));
      expect(screen.queryByAltText("Attached 1")).not.toBeInTheDocument();
    });

    it("sends images array with user_message on submit", async () => {
      const user = userEvent.setup();
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      const file = new File(["(binary)"], "img.png", { type: "image/png" });
      const mock = mockFileReader("data:image/png;base64,abc123");

      fireEvent.drop(composer, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
      act(() => mock.triggerOnload());
      mock.restore();

      await user.type(screen.getByLabelText("Message input"), "check this{Enter}");

      expect(send).toHaveBeenCalledWith(
        {
          type: "user_message",
          content: "check this",
          images: [{ media_type: "image/png", data: "abc123" }],
        },
        SESSION,
      );
    });

    it("clears image previews after sending", async () => {
      const user = userEvent.setup();
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      const file = new File(["(binary)"], "img.png", { type: "image/png" });
      const mock = mockFileReader("data:image/png;base64,xyz");

      fireEvent.drop(composer, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
      act(() => mock.triggerOnload());
      mock.restore();

      expect(screen.getByAltText("Attached 1")).toBeInTheDocument();

      await user.type(screen.getByLabelText("Message input"), "sent{Enter}");

      expect(screen.queryByAltText("Attached 1")).not.toBeInTheDocument();
    });

    it("enables send button when images are attached even with empty text", () => {
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      const file = new File(["(binary)"], "img.png", { type: "image/png" });
      const mock = mockFileReader("data:image/png;base64,abc");

      fireEvent.drop(composer, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
      act(() => mock.triggerOnload());
      mock.restore();

      expect(screen.getByLabelText("Send message")).toBeEnabled();
    });
  });

  // ── Image upload error toasts ────────────────────────────────────

  describe("image upload error toasts", () => {
    function renderComposer() {
      store().ensureSessionData(SESSION);
      return render(<Composer sessionId={SESSION} />);
    }

    it("shows toast when image exceeds size limit", () => {
      const addToast = vi.spyOn(store(), "addToast");
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      // Create a file that reports > 10MB size
      const bigFile = new File(["x"], "huge.png", { type: "image/png" });
      Object.defineProperty(bigFile, "size", { value: 11 * 1024 * 1024 });

      fireEvent.drop(composer, {
        dataTransfer: { files: [bigFile], types: ["Files"] },
      });

      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("too large"), "error");
    });

    it("shows toast when max images reached", () => {
      const addToast = vi.spyOn(store(), "addToast");
      const { container } = renderComposer();
      const composer = container.firstChild as HTMLElement;

      // Fill up the image slots by repeatedly dropping files
      // We'll use a mock FileReader approach — but for this test, we just
      // need processFiles to detect the limit. The images state must be full.
      // Easiest: drop 10 images first, then try to drop one more.
      // Since processFiles uses imagesRef.current, we can set the state directly.
      // Instead, let's verify via the addToast call when slots are full.
      // The simplest approach: mock imagesRef by dropping once with > MAX files.
      const files: File[] = [];
      for (let i = 0; i < 11; i++) {
        files.push(new File(["x"], `img${i}.png`, { type: "image/png" }));
      }

      fireEvent.drop(composer, {
        dataTransfer: { files, types: ["Files"] },
      });

      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Maximum"), "error");
    });
  });

  // ── Observer mode ──────────────────────────────────────────────────

  describe("observer mode", () => {
    it("disables textarea when identity role is observer", () => {
      store().ensureSessionData(SESSION);
      store().setIdentity(SESSION, { userId: "u1", displayName: "Bob", role: "observer" });
      render(<Composer sessionId={SESSION} />);

      expect(screen.getByLabelText("Message input")).toBeDisabled();
    });

    it("shows observer placeholder when identity role is observer", () => {
      store().ensureSessionData(SESSION);
      store().setIdentity(SESSION, { userId: "u1", displayName: "Bob", role: "observer" });
      render(<Composer sessionId={SESSION} />);

      expect(screen.getByPlaceholderText(/Observer mode/)).toBeInTheDocument();
    });

    it("disables send button when observer", () => {
      store().ensureSessionData(SESSION);
      store().setIdentity(SESSION, { userId: "u1", displayName: "Bob", role: "observer" });
      render(<Composer sessionId={SESSION} />);

      expect(screen.getByLabelText("Send message")).toBeDisabled();
    });

    it("keeps controls enabled when identity is null (backward compatibility)", () => {
      store().ensureSessionData(SESSION);
      render(<Composer sessionId={SESSION} />);

      expect(screen.getByLabelText("Message input")).not.toBeDisabled();
    });

    it("keeps controls enabled when role is participant", () => {
      store().ensureSessionData(SESSION);
      store().setIdentity(SESSION, { userId: "u1", displayName: "Alice", role: "participant" });
      render(<Composer sessionId={SESSION} />);

      expect(screen.getByLabelText("Message input")).not.toBeDisabled();
    });
  });

  // ── Argument hints ──────────────────────────────────────────────────

  describe("argument hints", () => {
    it("shows argument hint when a known command is followed by a space", async () => {
      const user = userEvent.setup();
      store().ensureSessionData(SESSION);
      store().setCapabilities(SESSION, {
        commands: [{ name: "model", description: "Show or switch model", argumentHint: "[model]" }],
        models: [],
        skills: [],
      });
      render(<Composer sessionId={SESSION} />);

      await user.type(screen.getByLabelText("Message input"), "/model ");
      expect(screen.getByText("[model]")).toBeInTheDocument();
    });

    it("does not show argument hint when command has no hint", async () => {
      const user = userEvent.setup();
      store().ensureSessionData(SESSION);
      store().setCapabilities(SESSION, {
        commands: [{ name: "help", description: "Show help" }],
        models: [],
        skills: [],
      });
      render(<Composer sessionId={SESSION} />);

      await user.type(screen.getByLabelText("Message input"), "/help ");
      expect(screen.queryByTestId("argument-hint")).not.toBeInTheDocument();
    });

    it("hides argument hint once the user starts typing arguments", async () => {
      const user = userEvent.setup();
      store().ensureSessionData(SESSION);
      store().setCapabilities(SESSION, {
        commands: [{ name: "model", description: "Show or switch model", argumentHint: "[model]" }],
        models: [],
        skills: [],
      });
      render(<Composer sessionId={SESSION} />);

      const textarea = screen.getByLabelText("Message input");
      await user.type(textarea, "/model ");
      expect(screen.getByText("[model]")).toBeInTheDocument();

      await user.type(textarea, "opus");
      expect(screen.queryByText("[model]")).not.toBeInTheDocument();
    });

    it("matches command names with or without leading slash", async () => {
      const user = userEvent.setup();
      store().ensureSessionData(SESSION);
      store().setCapabilities(SESSION, {
        commands: [{ name: "/config", description: "Show config", argumentHint: "[key]" }],
        models: [],
        skills: [],
      });
      render(<Composer sessionId={SESSION} />);

      await user.type(screen.getByLabelText("Message input"), "/config ");
      expect(screen.getByText("[key]")).toBeInTheDocument();
    });
  });

  // ── Accessibility ──────────────────────────────────────────────────

  describe("accessibility", () => {
    it("has no axe violations", async () => {
      store().ensureSessionData(SESSION);
      render(<Composer sessionId={SESSION} />);
      const results = await checkA11y();
      expect(results).toHaveNoViolations();
    });
  });

  // ── Queue message editing ──────────────────────────────────────────

  describe("queue message editing", () => {
    function setupQueue() {
      store().ensureSessionData(SESSION);
      store().setSessionStatus(SESSION, "running");
      store().setIdentity(SESSION, { userId: "u1", displayName: "User 1", role: "participant" });
      store().setQueuedMessage(SESSION, {
        consumerId: "u1",
        displayName: "User 1",
        content: "queued text",
        queuedAt: Date.now(),
      });
    }

    it("makes textarea readOnly (not disabled) when own queue message exists", () => {
      setupQueue();
      render(<Composer sessionId={SESSION} />);

      const textarea = screen.getByLabelText("Message input");
      expect(textarea).not.toBeDisabled();
      expect(textarea).toHaveAttribute("readonly");
    });

    it("disables textarea when another user has a queued message", () => {
      store().ensureSessionData(SESSION);
      store().setSessionStatus(SESSION, "running");
      store().setIdentity(SESSION, { userId: "u2", displayName: "User 2", role: "participant" });
      store().setQueuedMessage(SESSION, {
        consumerId: "u1",
        displayName: "User 1",
        content: "someone else queued",
        queuedAt: Date.now(),
      });
      render(<Composer sessionId={SESSION} />);

      expect(screen.getByLabelText("Message input")).toBeDisabled();
    });

    it("populates textarea with queued content on ArrowUp", async () => {
      const user = userEvent.setup();
      setupQueue();
      render(<Composer sessionId={SESSION} />);

      const textarea = screen.getByLabelText("Message input");
      await user.click(textarea);
      await user.keyboard("{ArrowUp}");

      expect(textarea).toHaveValue("queued text");
    });

    it("sends update_queued_message when editing and submitting", async () => {
      const user = userEvent.setup();
      setupQueue();
      render(<Composer sessionId={SESSION} />);

      const textarea = screen.getByLabelText("Message input");
      await user.click(textarea);
      await user.keyboard("{ArrowUp}");

      // Now in editing mode — clear and type new content
      await user.clear(textarea);
      await user.type(textarea, "updated text{Enter}");

      expect(send).toHaveBeenCalledWith(
        { type: "update_queued_message", content: "updated text" },
        SESSION,
      );
    });

    it("sends cancel_queued_message when editing and submitting empty", async () => {
      const user = userEvent.setup();
      setupQueue();
      render(<Composer sessionId={SESSION} />);

      const textarea = screen.getByLabelText("Message input");
      await user.click(textarea);
      await user.keyboard("{ArrowUp}");

      await user.clear(textarea);
      await user.keyboard("{Enter}");

      expect(send).toHaveBeenCalledWith({ type: "cancel_queued_message" }, SESSION);
    });
  });
});
