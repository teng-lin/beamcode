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
      const content =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
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
        parts.push(`### Assistant\n\n${msg.message.content.map(renderBlock).join("\n\n")}\n`);
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
