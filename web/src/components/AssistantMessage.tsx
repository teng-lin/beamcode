import { useMemo } from "react";
import type { AssistantContent, ConsumerContentBlock } from "../../../shared/consumer-types";
import { AgentRosterBlock } from "./AgentRosterBlock";
import { CodeBlock } from "./CodeBlock";
import { ImageBlock } from "./ImageBlock";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock } from "./ToolBlock";
import { ToolGroupBlock } from "./ToolGroupBlock";
import { ToolResultBlock } from "./ToolResultBlock";

interface AssistantMessageProps {
  message: AssistantContent;
  sessionId: string;
}

interface ContentGroup {
  type: ConsumerContentBlock["type"] | "tool_group";
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
      const bk = blockKey(block);
      groups.push({
        type: block.type,
        blocks: [block],
        key: `${block.type}-${bk || groupIndex}`,
      });
      groupIndex++;
    }
  }
  flushToolGroup();

  return groups;
}

export function AssistantMessage({ message, sessionId }: AssistantMessageProps) {
  const { groups, toolNameByUseId } = useMemo(() => {
    const nameMap = new Map<string, string>();
    for (const block of message.content) {
      if (block.type === "tool_use") {
        nameMap.set(block.id, block.name);
      }
    }
    return { groups: groupContentBlocks(message.content), toolNameByUseId: nameMap };
  }, [message.content]);

  return (
    <div className="flex flex-col gap-1.5 text-sm">
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

          case "tool_group": {
            const toolBlocks = group.blocks.filter(
              (b): b is Extract<ConsumerContentBlock, { type: "tool_use" }> =>
                b.type === "tool_use",
            );
            if (toolBlocks.length > 0 && toolBlocks[0].name === "Task") {
              return <AgentRosterBlock key={group.key} blocks={toolBlocks} sessionId={sessionId} />;
            }
            return <ToolGroupBlock key={group.key} blocks={toolBlocks} sessionId={sessionId} />;
          }

          case "tool_result": {
            const block = group.blocks[0];
            if (block.type !== "tool_result") return null;
            return (
              <ToolResultBlock
                key={group.key}
                toolName={toolNameByUseId.get(block.tool_use_id) ?? null}
                content={block.content}
                isError={block.is_error}
              />
            );
          }

          case "code": {
            const block = group.blocks[0];
            if (block.type !== "code") return null;
            return <CodeBlock key={group.key} language={block.language} code={block.code} />;
          }

          case "image": {
            const block = group.blocks[0];
            if (block.type !== "image") return null;
            return <ImageBlock key={group.key} mediaType={block.media_type} data={block.data} />;
          }

          case "refusal": {
            const block = group.blocks[0];
            if (block.type !== "refusal") return null;
            const text =
              block.refusal.length > 500 ? `${block.refusal.slice(0, 500)}…` : block.refusal;
            return (
              <div key={group.key} className="text-xs text-bc-text-muted italic opacity-70 px-1">
                {text}
              </div>
            );
          }

          default:
            return null;
        }
      })}
    </div>
  );
}
