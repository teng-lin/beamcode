import type {
  AssistantContent,
  ConsumerContentBlock,
  ConsumerMessage,
  ResultData,
} from "../types/consumer-messages.js";

declare const marked: { parse(md: string): string };

/** Strips script tags and event-handler attributes from HTML. */
function sanitizeHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const s of div.querySelectorAll("script,iframe,object,embed")) s.remove();
  for (const el of div.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
      if (
        (attr.name === "href" || attr.name === "src") &&
        attr.value.trimStart().startsWith("javascript:")
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return div.innerHTML;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Renders ConsumerMessage objects into DOM elements for display.
 * Uses `marked` for Markdown rendering with basic XSS sanitization.
 */
export class MessageRenderer {
  render(message: ConsumerMessage): HTMLElement | null {
    switch (message.type) {
      case "assistant":
        return this.renderAssistant(message.message);
      case "result":
        return this.renderResult(message.data);
      case "status_change":
        return this.renderStatus(message.status ?? "unknown");
      case "error":
        return this.renderSystem(message.message, "error");
      case "cli_connected":
        return this.renderSystem("CLI connected", "success");
      case "cli_disconnected":
        return this.renderSystem("CLI disconnected", "warning");
      case "user_message":
        return this.renderUserMessage(message.content);
      case "slash_command_result":
        return this.renderSystem(message.content, "info");
      case "slash_command_error":
        return this.renderSystem(message.error, "error");
      default:
        return null;
    }
  }

  renderAssistant(content: AssistantContent): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "msg msg-assistant";

    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = "Assistant";
    if (content.model) {
      const model = document.createElement("span");
      model.className = "model-tag";
      model.textContent = content.model;
      label.appendChild(model);
    }
    wrapper.appendChild(label);

    const body = document.createElement("div");
    body.className = "msg-body";
    for (const block of content.content) {
      body.appendChild(this.renderBlock(block));
    }
    wrapper.appendChild(body);
    return wrapper;
  }

  renderResult(data: ResultData): HTMLElement {
    const el = document.createElement("div");
    el.className = `msg msg-result ${data.is_error ? "result-error" : "result-success"}`;

    const duration = (data.duration_ms / 1000).toFixed(1);
    const cost = data.total_cost_usd.toFixed(4);
    const tokens = data.usage.input_tokens + data.usage.output_tokens;

    let text = `${data.is_error ? "Error" : "Done"} — ${duration}s · $${cost} · ${tokens} tokens`;
    if (data.total_lines_added || data.total_lines_removed) {
      text += ` · +${data.total_lines_added ?? 0}/-${data.total_lines_removed ?? 0}`;
    }
    el.textContent = text;
    return el;
  }

  renderStatus(status: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "msg msg-status";
    el.textContent = status === "idle" ? "" : status;
    return status === "idle" ? el : el;
  }

  private renderBlock(block: ConsumerContentBlock): HTMLElement {
    switch (block.type) {
      case "text":
        return this.renderTextBlock(block.text);
      case "tool_use":
        return this.renderToolUse(block.name, block.input);
      case "tool_result":
        return this.renderToolResult(block.content, block.is_error);
      case "thinking":
        return this.renderThinking(block.thinking);
      default:
        return document.createElement("span");
    }
  }

  private renderTextBlock(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "content-block text-block";
    el.innerHTML = sanitizeHtml(marked.parse(text));
    return el;
  }

  private renderToolUse(name: string, input: Record<string, unknown>): HTMLElement {
    const el = document.createElement("div");
    el.className = "content-block tool-use-block";
    const header = document.createElement("div");
    header.className = "tool-header";
    header.textContent = `Tool: ${name}`;
    el.appendChild(header);

    const preview = document.createElement("pre");
    preview.className = "tool-input";
    preview.textContent = truncate(JSON.stringify(input, null, 2), 500);
    el.appendChild(preview);
    return el;
  }

  private renderToolResult(
    content: string | ConsumerContentBlock[],
    isError?: boolean,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = `content-block tool-result-block ${isError ? "tool-error" : ""}`;
    if (typeof content === "string") {
      const pre = document.createElement("pre");
      pre.textContent = truncate(content, 2000);
      el.appendChild(pre);
    } else {
      for (const block of content) el.appendChild(this.renderBlock(block));
    }
    return el;
  }

  private renderThinking(text: string): HTMLElement {
    const details = document.createElement("details");
    details.className = "content-block thinking-block";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking…";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = text;
    details.appendChild(pre);
    return details;
  }

  private renderUserMessage(content: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "msg msg-user";
    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = "You";
    el.appendChild(label);
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = content;
    el.appendChild(body);
    return el;
  }

  private renderSystem(text: string, level: "info" | "success" | "warning" | "error"): HTMLElement {
    const el = document.createElement("div");
    el.className = `msg msg-system msg-${level}`;
    el.textContent = text;
    return el;
  }
}
