import type { AgentGridItem } from "../hooks/useAgentGrid";
import { AgentColumn } from "./AgentColumn";

interface AgentGridViewProps {
  agents: AgentGridItem[];
  sessionId: string;
}

export function AgentGridView({ agents, sessionId }: AgentGridViewProps) {
  return (
    <div className="flex min-h-0 flex-1 overflow-x-auto [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-bc-border [&::-webkit-scrollbar-track]:bg-transparent">
      {agents.map((agent) => (
        <AgentColumn
          key={agent.blockId}
          agentId={agent.blockId}
          name={agent.name}
          type={agent.type}
          status={agent.status}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}
