import { useMemo } from "react";
import type { AssistantContent, ConsumerContentBlock } from "../../../shared/consumer-types";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock } from "./ToolBlock";
import { ToolGroupBlock } from "./ToolGroupBlock";

interface AssistantMessageProps {
  message: AssistantContent;
  sessionId: string;
}

interface ContentGroup {
  type: "text" | "thinking" | "tool_use" | "tool_group" | "tool_result";
  blocks: ConsumerContentBlock[];
  key: string;
}

function blockKey(block: ConsumerContentBlock): string {
  if ("id" in block && typeof block.id === "string") return block.id;
  if ("tool_use_id" in block && typeof block.tool_use_id === "string") return block.tool_use_id;
  return "";
}

function groupContentBlocks(blocks: ConsumerContentBlock[]): ContentGroup[] {
  const groups: ContentGroup[] = [];
  let currentToolGroup: ConsumerContentBlock[] = [];
  let currentToolName: string | null = null;
  let groupIndex = 0;

  const flushToolGroup = () => {
    if (currentToolGroup.length === 0) return;
    const firstKey = blockKey(currentToolGroup[0]);
    if (currentToolGroup.length >= 2) {
      groups.push({
        type: "tool_group",
        blocks: [...currentToolGroup],
        key: `tg-${firstKey || groupIndex}`,
      });
    } else {
      groups.push({
        type: "tool_use",
        blocks: [...currentToolGroup],
        key: `tu-${firstKey || groupIndex}`,
      });
    }
    groupIndex++;
    currentToolGroup = [];
    currentToolName = null;
  };

  for (const block of blocks) {
    if (block.type === "tool_use") {
      if (currentToolName !== block.name) {
        flushToolGroup();
        currentToolName = block.name;
      }
      currentToolGroup.push(block);
    } else {
      flushToolGroup();
      if (block.type === "text" || block.type === "thinking" || block.type === "tool_result") {
        const bk = blockKey(block);
        groups.push({
          type: block.type,
          blocks: [block],
          key: `${block.type}-${bk || groupIndex}`,
        });
        groupIndex++;
      }
    }
  }
  flushToolGroup();

  return groups;
}

export function AssistantMessage({ message, sessionId }: AssistantMessageProps) {
  const groups = useMemo(() => groupContentBlocks(message.content), [message.content]);

  return (
    <div className="animate-fadeSlideIn flex flex-col gap-1.5 text-sm">
      {groups.map((group) => {
        switch (group.type) {
          case "text": {
            const block = group.blocks[0];
            if (block.type !== "text") return null;
            return <MarkdownContent key={group.key} content={block.text} />;
          }

          case "thinking": {
            const block = group.blocks[0];
            if (block.type !== "thinking") return null;
            return <ThinkingBlock key={group.key} content={block.thinking} />;
          }

          case "tool_use": {
            const block = group.blocks[0];
            if (block.type !== "tool_use") return null;
            return (
              <ToolBlock
                key={group.key}
                id={block.id}
                name={block.name}
                input={block.input}
                sessionId={sessionId}
              />
            );
          }

          case "tool_group":
            return (
              <ToolGroupBlock
                key={group.key}
                blocks={group.blocks.filter(
                  (b): b is Extract<ConsumerContentBlock, { type: "tool_use" }> =>
                    b.type === "tool_use",
                )}
                sessionId={sessionId}
              />
            );

          case "tool_result": {
            const block = group.blocks[0];
            if (block.type !== "tool_result") return null;
            const content =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content, null, 2);
            return (
              <details key={group.key} className="rounded border border-bc-border">
                <summary
                  className={`cursor-pointer px-2 py-1 text-xs ${
                    block.is_error ? "text-bc-error" : "text-bc-text-muted"
                  }`}
                >
                  Tool result {block.is_error ? "(error)" : ""}
                </summary>
                <pre className="max-h-40 overflow-auto p-2 font-mono-code text-xs text-bc-text-muted">
                  {content}
                </pre>
              </details>
            );
          }

          default:
            return null;
        }
      })}
    </div>
  );
}
