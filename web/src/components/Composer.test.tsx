import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

    expect(send).toHaveBeenCalledWith({
      type: "user_message",
      content: "hello",
    });
  });

  it('sends slash_command when input starts with "/"', async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "/help{Enter}");

    expect(send).toHaveBeenCalledWith({
      type: "slash_command",
      command: "/help",
    });
  });

  it("clears input after sending", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "hello{Enter}");

    expect(textarea).toHaveValue("");
  });

  it("shows interrupt button when session is running", () => {
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
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

    expect(send).toHaveBeenCalledWith({ type: "interrupt" });
  });

  it("sends interrupt on Escape when running", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "{Escape}");

    expect(send).toHaveBeenCalledWith({ type: "interrupt" });
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

      expect(send).toHaveBeenCalledWith({
        type: "user_message",
        content: "check this",
        images: [{ media_type: "image/png", data: "abc123" }],
      });
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
});
