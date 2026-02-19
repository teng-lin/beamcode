import { describe, expect, it } from "vitest";
import type { RecognizedTeamToolUse } from "./team-tool-recognizer.js";
import { recognizeTeamToolUses } from "./team-tool-recognizer.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an assistant message with one or more tool_use content blocks. */
function assistantWithToolUses(
  blocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): UnifiedMessage {
  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content: blocks.map((b) => ({
      type: "tool_use" as const,
      id: b.id,
      name: b.name,
      input: b.input,
    })),
  });
}

// ---------------------------------------------------------------------------
// Unambiguous team tools
// ---------------------------------------------------------------------------

describe("recognizeTeamToolUses", () => {
  describe("unambiguous team tools", () => {
    it("recognizes TeamCreate as team_state_change", () => {
      const msg = assistantWithToolUses([
        { id: "tu-1", name: "TeamCreate", input: { team_name: "my-team" } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "TeamCreate",
        toolUseId: "tu-1",
        category: "team_state_change",
        input: { team_name: "my-team" },
      });
    });

    it("recognizes TeamDelete as team_state_change", () => {
      const msg = assistantWithToolUses([{ id: "tu-2", name: "TeamDelete", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "TeamDelete",
        toolUseId: "tu-2",
        category: "team_state_change",
        input: {},
      });
    });

    it("recognizes TaskCreate as team_task_update", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-3",
          name: "TaskCreate",
          input: { subject: "Fix bug", description: "Details..." },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "TaskCreate",
        toolUseId: "tu-3",
        category: "team_task_update",
        input: { subject: "Fix bug", description: "Details..." },
      });
    });

    it("recognizes TaskUpdate as team_task_update", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-4",
          name: "TaskUpdate",
          input: { taskId: "1", status: "completed" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "TaskUpdate",
        toolUseId: "tu-4",
        category: "team_task_update",
        input: { taskId: "1", status: "completed" },
      });
    });

    it("recognizes TaskList as team_task_update", () => {
      const msg = assistantWithToolUses([{ id: "tu-5", name: "TaskList", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "TaskList",
        toolUseId: "tu-5",
        category: "team_task_update",
        input: {},
      });
    });

    it("recognizes TaskGet as team_task_update", () => {
      const msg = assistantWithToolUses([{ id: "tu-6", name: "TaskGet", input: { taskId: "3" } }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "TaskGet",
        toolUseId: "tu-6",
        category: "team_task_update",
        input: { taskId: "3" },
      });
    });

    it("recognizes SendMessage as team_message", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-7",
          name: "SendMessage",
          input: { type: "message", recipient: "worker-1", content: "Hello" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "SendMessage",
        toolUseId: "tu-7",
        category: "team_message",
        input: { type: "message", recipient: "worker-1", content: "Hello" },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Task tool — compound discriminator
  // ---------------------------------------------------------------------------

  describe("Task tool — compound discriminator", () => {
    it("recognizes Task with both team_name and name as team_state_change", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-8",
          name: "Task",
          input: {
            team_name: "my-team",
            name: "worker-1",
            prompt: "Do work",
          },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolName: "Task",
        toolUseId: "tu-8",
        category: "team_state_change",
        input: { team_name: "my-team", name: "worker-1", prompt: "Do work" },
      });
    });

    it("ignores Task with only description (subagent, no team_name)", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-9",
          name: "Task",
          input: { description: "Research something" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("ignores Task with team_name but no name", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-10",
          name: "Task",
          input: { team_name: "my-team", description: "Do work" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("ignores Task with name but no team_name", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-11",
          name: "Task",
          input: { name: "worker-1", description: "Do work" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("ignores Task with empty string team_name", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-12",
          name: "Task",
          input: { team_name: "", name: "worker-1" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("ignores Task with empty string name", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-13",
          name: "Task",
          input: { team_name: "my-team", name: "" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-team tools
  // ---------------------------------------------------------------------------

  describe("non-team tools", () => {
    it("ignores Read tool", () => {
      const msg = assistantWithToolUses([
        { id: "tu-20", name: "Read", input: { file_path: "/foo" } },
      ]);
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });

    it("ignores Write tool", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-21",
          name: "Write",
          input: { file_path: "/foo", content: "bar" },
        },
      ]);
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });

    it("ignores Bash tool", () => {
      const msg = assistantWithToolUses([{ id: "tu-22", name: "Bash", input: { command: "ls" } }]);
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });

    it("ignores Glob tool", () => {
      const msg = assistantWithToolUses([
        { id: "tu-23", name: "Glob", input: { pattern: "*.ts" } },
      ]);
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple tool_use blocks
  // ---------------------------------------------------------------------------

  describe("multiple tool_use blocks", () => {
    it("handles multiple team tools in a single message", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-30",
          name: "TaskCreate",
          input: { subject: "Task A" },
        },
        {
          id: "tu-31",
          name: "TaskCreate",
          input: { subject: "Task B" },
        },
        {
          id: "tu-32",
          name: "SendMessage",
          input: { type: "broadcast", content: "Starting work" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(3);
      expect(results[0]!.toolUseId).toBe("tu-30");
      expect(results[1]!.toolUseId).toBe("tu-31");
      expect(results[2]!.toolUseId).toBe("tu-32");
    });

    it("filters team tools from mixed content blocks", () => {
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          { type: "text", text: "Let me create some tasks." },
          {
            type: "tool_use",
            id: "tu-40",
            name: "TaskCreate",
            input: { subject: "Fix bug" },
          },
          {
            type: "tool_use",
            id: "tu-41",
            name: "Read",
            input: { file_path: "/src/main.ts" },
          },
          {
            type: "tool_use",
            id: "tu-42",
            name: "SendMessage",
            input: { type: "message", recipient: "lead", content: "Done" },
          },
        ],
      });
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(2);
      expect(results[0]!.toolName).toBe("TaskCreate");
      expect(results[1]!.toolName).toBe("SendMessage");
    });
  });

  // ---------------------------------------------------------------------------
  // Messages without tool_use blocks
  // ---------------------------------------------------------------------------

  describe("messages without tool_use blocks", () => {
    it("returns empty array for text-only messages", () => {
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      });
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });

    it("returns empty array for messages with no content", () => {
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [],
      });
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });

    it("returns empty array for tool_result blocks", () => {
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-50",
            content: "result data",
          },
        ],
      });
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });

    it("returns empty array for non-assistant messages", () => {
      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude-4" },
      });
      expect(recognizeTeamToolUses(msg)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Input validation — required fields
  // ---------------------------------------------------------------------------

  describe("input validation", () => {
    it("skips TeamCreate with missing team_name", () => {
      const msg = assistantWithToolUses([{ id: "tu-60", name: "TeamCreate", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("skips TaskCreate with missing subject", () => {
      const msg = assistantWithToolUses([
        { id: "tu-61", name: "TaskCreate", input: { description: "No subject" } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("skips TaskUpdate with missing taskId", () => {
      const msg = assistantWithToolUses([
        { id: "tu-62", name: "TaskUpdate", input: { status: "completed" } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("skips TaskGet with missing taskId", () => {
      const msg = assistantWithToolUses([{ id: "tu-63", name: "TaskGet", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("skips SendMessage with missing type", () => {
      const msg = assistantWithToolUses([
        {
          id: "tu-64",
          name: "SendMessage",
          input: { recipient: "worker-1", content: "Hello" },
        },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("allows TeamDelete with no required fields", () => {
      const msg = assistantWithToolUses([{ id: "tu-65", name: "TeamDelete", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
    });

    it("allows TaskList with no required fields", () => {
      const msg = assistantWithToolUses([{ id: "tu-66", name: "TaskList", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
    });

    it("skips invalid tools but includes valid ones in same message", () => {
      const msg = assistantWithToolUses([
        { id: "tu-70", name: "TaskCreate", input: {} }, // missing subject
        { id: "tu-71", name: "TaskCreate", input: { subject: "Valid" } }, // valid
        { id: "tu-72", name: "SendMessage", input: {} }, // missing type
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]!.toolUseId).toBe("tu-71");
    });
  });

  // ---------------------------------------------------------------------------
  // Warning for unknown Team*/Task* tools
  // ---------------------------------------------------------------------------

  describe("unknown team/task tool handling", () => {
    it("ignores unknown Team-prefixed tools", () => {
      const msg = assistantWithToolUses([
        { id: "tu-80", name: "TeamFoo", input: { something: true } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("ignores unknown Task-prefixed tools (not in recognized set)", () => {
      const msg = assistantWithToolUses([{ id: "tu-81", name: "TaskDelete", input: {} }]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });

    it("recognizes known tools without warnings", () => {
      const msg = assistantWithToolUses([
        { id: "tu-82", name: "TaskCreate", input: { subject: "Valid" } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
    });

    it("ignores non-Team/Task prefixed tools", () => {
      const msg = assistantWithToolUses([
        { id: "tu-83", name: "Read", input: { file_path: "/foo" } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Category correctness
  // ---------------------------------------------------------------------------

  describe("category correctness", () => {
    const categoryTests: Array<{
      name: string;
      input: Record<string, unknown>;
      expected: RecognizedTeamToolUse["category"];
    }> = [
      { name: "TeamCreate", input: { team_name: "t" }, expected: "team_state_change" },
      { name: "TeamDelete", input: {}, expected: "team_state_change" },
      { name: "TaskCreate", input: { subject: "s" }, expected: "team_task_update" },
      { name: "TaskUpdate", input: { taskId: "1" }, expected: "team_task_update" },
      { name: "TaskList", input: {}, expected: "team_task_update" },
      { name: "TaskGet", input: { taskId: "1" }, expected: "team_task_update" },
      { name: "SendMessage", input: { type: "message" }, expected: "team_message" },
    ];

    for (const { name, input, expected } of categoryTests) {
      it(`${name} → ${expected}`, () => {
        const msg = assistantWithToolUses([{ id: "tu-cat", name, input }]);
        const results = recognizeTeamToolUses(msg);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe(expected);
      });
    }

    it("Task (team spawn) → team_state_change", () => {
      const msg = assistantWithToolUses([
        { id: "tu-cat-task", name: "Task", input: { team_name: "t", name: "w" } },
      ]);
      const results = recognizeTeamToolUses(msg);
      expect(results).toHaveLength(1);
      expect(results[0]!.category).toBe("team_state_change");
    });
  });
});
