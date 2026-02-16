import { describe, expect, it } from "vitest";
import type { SequencedMessage } from "../core/types/sequenced-message.js";
import { MessageSequencer } from "../core/types/sequenced-message.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import { ReconnectionHandler } from "./reconnection-handler.js";

/** Helper to create a sequenced consumer message. */
function makeMsg(seq: number, type: ConsumerMessage["type"]): SequencedMessage<ConsumerMessage> {
  let payload: ConsumerMessage;
  switch (type) {
    case "stream_event":
      payload = { type: "stream_event", event: {}, parent_tool_use_id: null };
      break;
    case "result":
      payload = {
        type: "result",
        data: {
          subtype: "success",
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      };
      break;
    default:
      payload = { type, event: {}, parent_tool_use_id: null } as ConsumerMessage;
  }
  return {
    seq,
    message_id: `msg-${seq}`,
    timestamp: Date.now(),
    payload,
  };
}

describe("ReconnectionHandler", () => {
  // -----------------------------------------------------------------------
  // Consumer registration
  // -----------------------------------------------------------------------

  describe("consumer registration", () => {
    it("assigns a new consumer ID", () => {
      const handler = new ReconnectionHandler();
      const id = handler.registerConsumer("session-1");
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("reuses existing consumer ID on reconnection", () => {
      const handler = new ReconnectionHandler();
      const id1 = handler.registerConsumer("session-1");
      const id2 = handler.registerConsumer("session-1", id1);
      expect(id2).toBe(id1);
    });

    it("assigns a new ID if existingId is unknown", () => {
      const handler = new ReconnectionHandler();
      const id = handler.registerConsumer("session-1", "unknown-id");
      expect(id).toBe("unknown-id");
    });

    it("registers multiple consumers for the same session", () => {
      const handler = new ReconnectionHandler();
      const id1 = handler.registerConsumer("session-1");
      const id2 = handler.registerConsumer("session-1");
      expect(id1).not.toBe(id2);
    });
  });

  // -----------------------------------------------------------------------
  // Record and replay
  // -----------------------------------------------------------------------

  describe("record and replay", () => {
    it("records and replays messages after lastSeenSeq", () => {
      const handler = new ReconnectionHandler();
      handler.registerConsumer("s1");

      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      handler.recordMessage("s1", makeMsg(2, "stream_event"));
      handler.recordMessage("s1", makeMsg(3, "result"));

      const replay = handler.getReplayMessages("s1", 1);
      expect(replay).toHaveLength(2);
      expect(replay[0].seq).toBe(2);
      expect(replay[1].seq).toBe(3);
    });

    it("returns all messages when lastSeenSeq is 0", () => {
      const handler = new ReconnectionHandler();
      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      handler.recordMessage("s1", makeMsg(2, "result"));

      const replay = handler.getReplayMessages("s1", 0);
      expect(replay).toHaveLength(2);
    });

    it("returns empty array for unknown session", () => {
      const handler = new ReconnectionHandler();
      expect(handler.getReplayMessages("unknown", 0)).toEqual([]);
    });

    it("returns empty when consumer has seen everything", () => {
      const handler = new ReconnectionHandler();
      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      handler.recordMessage("s1", makeMsg(2, "stream_event"));

      const replay = handler.getReplayMessages("s1", 2);
      expect(replay).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Full reconnection flow
  // -----------------------------------------------------------------------

  describe("reconnection flow", () => {
    it("register → record → disconnect → reconnect → replay", () => {
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();

      // First connection
      const consumerId = handler.registerConsumer("s1");

      // Record some messages
      const msg1 = sequencer.next({ type: "stream_event", event: {}, parent_tool_use_id: null });
      const msg2 = sequencer.next({ type: "stream_event", event: {}, parent_tool_use_id: null });
      const msg3 = sequencer.next({
        type: "result",
        data: {
          subtype: "success",
          is_error: false,
          duration_ms: 100,
          duration_api_ms: 50,
          num_turns: 1,
          total_cost_usd: 0.01,
          stop_reason: null,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      handler.recordMessage("s1", msg1);
      handler.recordMessage("s1", msg2);
      handler.recordMessage("s1", msg3);

      // Consumer saw up to seq 2, then disconnected
      handler.updateLastSeen(consumerId, 2);

      // Reconnect with same ID
      const reconnectedId = handler.registerConsumer("s1", consumerId);
      expect(reconnectedId).toBe(consumerId);

      // Replay from last seen
      const lastSeen = handler.getLastSeen(consumerId);
      const replay = handler.getReplayMessages("s1", lastSeen);
      expect(replay).toHaveLength(1);
      expect(replay[0].seq).toBe(3);
      expect(replay[0].payload.type).toBe("result");
    });
  });

  // -----------------------------------------------------------------------
  // Initial messages for new connection
  // -----------------------------------------------------------------------

  describe("initial messages", () => {
    it("returns last N messages for a new connection", () => {
      const handler = new ReconnectionHandler({ initialReplayCount: 3 });

      for (let i = 1; i <= 10; i++) {
        handler.recordMessage("s1", makeMsg(i, "stream_event"));
      }

      const initial = handler.getInitialMessages("s1");
      expect(initial).toHaveLength(3);
      expect(initial[0].seq).toBe(8);
      expect(initial[1].seq).toBe(9);
      expect(initial[2].seq).toBe(10);
    });

    it("returns all messages if fewer than initialReplayCount", () => {
      const handler = new ReconnectionHandler({ initialReplayCount: 20 });
      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      handler.recordMessage("s1", makeMsg(2, "result"));

      const initial = handler.getInitialMessages("s1");
      expect(initial).toHaveLength(2);
    });

    it("returns empty for unknown session", () => {
      const handler = new ReconnectionHandler();
      expect(handler.getInitialMessages("unknown")).toEqual([]);
    });

    it("defaults to 20 messages", () => {
      const handler = new ReconnectionHandler();
      for (let i = 1; i <= 30; i++) {
        handler.recordMessage("s1", makeMsg(i, "stream_event"));
      }

      const initial = handler.getInitialMessages("s1");
      expect(initial).toHaveLength(20);
      expect(initial[0].seq).toBe(11);
    });
  });

  // -----------------------------------------------------------------------
  // Per-consumer isolation
  // -----------------------------------------------------------------------

  describe("per-consumer isolation", () => {
    it("one slow consumer does not affect another", () => {
      const handler = new ReconnectionHandler();

      const fast = handler.registerConsumer("s1");
      const slow = handler.registerConsumer("s1");

      // Record messages
      for (let i = 1; i <= 5; i++) {
        handler.recordMessage("s1", makeMsg(i, "stream_event"));
      }

      // Fast consumer has seen everything
      handler.updateLastSeen(fast, 5);
      // Slow consumer stuck at seq 2
      handler.updateLastSeen(slow, 2);

      const fastReplay = handler.getReplayMessages("s1", handler.getLastSeen(fast));
      const slowReplay = handler.getReplayMessages("s1", handler.getLastSeen(slow));

      expect(fastReplay).toHaveLength(0);
      expect(slowReplay).toHaveLength(3);
      expect(slowReplay[0].seq).toBe(3);
    });

    it("removing one consumer does not affect others", () => {
      const handler = new ReconnectionHandler();

      const id1 = handler.registerConsumer("s1");
      const id2 = handler.registerConsumer("s1");

      handler.updateLastSeen(id1, 5);
      handler.updateLastSeen(id2, 3);

      handler.removeConsumer(id1);

      // id2 still has its state
      expect(handler.getLastSeen(id2)).toBe(3);
      // id1 state is gone
      expect(handler.getLastSeen(id1)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // History capping
  // -----------------------------------------------------------------------

  describe("history capping", () => {
    it("caps history at maxHistoryPerSession", () => {
      const handler = new ReconnectionHandler({ maxHistoryPerSession: 5 });

      for (let i = 1; i <= 10; i++) {
        handler.recordMessage("s1", makeMsg(i, "stream_event"));
      }

      // Only the last 5 should remain
      const all = handler.getReplayMessages("s1", 0);
      expect(all).toHaveLength(5);
      expect(all[0].seq).toBe(6);
      expect(all[4].seq).toBe(10);
    });

    it("drops oldest messages when cap exceeded", () => {
      const handler = new ReconnectionHandler({ maxHistoryPerSession: 3 });

      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      handler.recordMessage("s1", makeMsg(2, "result"));
      handler.recordMessage("s1", makeMsg(3, "stream_event"));
      handler.recordMessage("s1", makeMsg(4, "result")); // seq 1 dropped

      const all = handler.getReplayMessages("s1", 0);
      expect(all).toHaveLength(3);
      expect(all[0].seq).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe("cleanup", () => {
    it("removeSession clears history and consumer mappings", () => {
      const handler = new ReconnectionHandler();
      const consumerId = handler.registerConsumer("s1");
      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      handler.updateLastSeen(consumerId, 1);

      handler.removeSession("s1");

      expect(handler.getReplayMessages("s1", 0)).toEqual([]);
      expect(handler.getInitialMessages("s1")).toEqual([]);
      expect(handler.getLastSeen(consumerId)).toBe(0);
    });

    it("removeConsumer only removes that consumer", () => {
      const handler = new ReconnectionHandler();
      const id1 = handler.registerConsumer("s1");
      handler.updateLastSeen(id1, 5);

      handler.removeConsumer(id1);
      expect(handler.getLastSeen(id1)).toBe(0);

      // Session history is still available
      handler.recordMessage("s1", makeMsg(1, "stream_event"));
      expect(handler.getReplayMessages("s1", 0)).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Last seen tracking
  // -----------------------------------------------------------------------

  describe("last seen tracking", () => {
    it("returns 0 for unknown consumer", () => {
      const handler = new ReconnectionHandler();
      expect(handler.getLastSeen("no-such-id")).toBe(0);
    });

    it("updates and retrieves last seen", () => {
      const handler = new ReconnectionHandler();
      const id = handler.registerConsumer("s1");
      handler.updateLastSeen(id, 42);
      expect(handler.getLastSeen(id)).toBe(42);
    });

    it("overwrites previous last seen value", () => {
      const handler = new ReconnectionHandler();
      const id = handler.registerConsumer("s1");
      handler.updateLastSeen(id, 10);
      handler.updateLastSeen(id, 25);
      expect(handler.getLastSeen(id)).toBe(25);
    });
  });
});
