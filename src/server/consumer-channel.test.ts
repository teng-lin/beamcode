import { describe, expect, it } from "vitest";
import type { SequencedMessage } from "../core/types/sequenced-message.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import { ConsumerChannel } from "./consumer-channel.js";

/** Helper to create a sequenced consumer message. */
function makeMsg(
  seq: number,
  type: ConsumerMessage["type"],
  extra?: Partial<ConsumerMessage>,
): SequencedMessage<ConsumerMessage> {
  let payload: ConsumerMessage;
  switch (type) {
    case "stream_event":
      payload = {
        type: "stream_event",
        event: {},
        parent_tool_use_id: null,
        ...extra,
      } as ConsumerMessage;
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
        ...extra,
      } as ConsumerMessage;
      break;
    case "permission_request":
      payload = {
        type: "permission_request",
        request: {
          request_id: "r1",
          tool_name: "bash",
          input: {},
          tool_use_id: "tu1",
          timestamp: Date.now(),
        },
        ...extra,
      } as ConsumerMessage;
      break;
    case "session_init":
      payload = {
        type: "session_init",
        session: {} as never,
        ...extra,
      } as ConsumerMessage;
      break;
    case "error":
      payload = { type: "error", message: "test error", ...extra } as ConsumerMessage;
      break;
    default:
      payload = { type, ...extra } as ConsumerMessage;
  }
  return {
    seq,
    message_id: `msg-${seq}`,
    timestamp: Date.now(),
    payload,
  };
}

describe("ConsumerChannel", () => {
  // -----------------------------------------------------------------------
  // Basic enqueue/drain
  // -----------------------------------------------------------------------

  describe("enqueue and drain", () => {
    it("enqueues and drains messages in order", () => {
      const channel = new ConsumerChannel();
      channel.enqueue(makeMsg(1, "stream_event"));
      channel.enqueue(makeMsg(2, "stream_event"));
      channel.enqueue(makeMsg(3, "result"));

      const drained = channel.drain();
      expect(drained).toHaveLength(3);
      expect(drained[0].seq).toBe(1);
      expect(drained[1].seq).toBe(2);
      expect(drained[2].seq).toBe(3);
    });

    it("drain clears the queue", () => {
      const channel = new ConsumerChannel();
      channel.enqueue(makeMsg(1, "stream_event"));
      expect(channel.queueSize).toBe(1);

      channel.drain();
      expect(channel.queueSize).toBe(0);
    });

    it("reports correct queueSize", () => {
      const channel = new ConsumerChannel();
      expect(channel.queueSize).toBe(0);
      channel.enqueue(makeMsg(1, "stream_event"));
      expect(channel.queueSize).toBe(1);
      channel.enqueue(makeMsg(2, "stream_event"));
      expect(channel.queueSize).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Backpressure: drops non-critical above high water mark
  // -----------------------------------------------------------------------

  describe("backpressure", () => {
    it("drops non-critical messages above high water mark", () => {
      const channel = new ConsumerChannel({ highWaterMark: 3, maxQueueSize: 100 });

      // Fill to high water mark
      channel.enqueue(makeMsg(1, "stream_event"));
      channel.enqueue(makeMsg(2, "stream_event"));
      channel.enqueue(makeMsg(3, "stream_event"));
      expect(channel.isOverflowing).toBe(true);

      // Non-critical messages should be dropped (enqueue returns true but not queued)
      const ok = channel.enqueue(makeMsg(4, "stream_event"));
      expect(ok).toBe(true);
      expect(channel.queueSize).toBe(3); // not added
    });

    it("keeps critical messages above high water mark", () => {
      const channel = new ConsumerChannel({ highWaterMark: 2, maxQueueSize: 100 });

      // Fill to high water mark
      channel.enqueue(makeMsg(1, "stream_event"));
      channel.enqueue(makeMsg(2, "stream_event"));

      // Critical messages should still be enqueued
      channel.enqueue(makeMsg(3, "permission_request"));
      channel.enqueue(makeMsg(4, "result"));
      channel.enqueue(makeMsg(5, "session_init"));
      channel.enqueue(makeMsg(6, "error"));

      expect(channel.queueSize).toBe(6);

      const drained = channel.drain();
      expect(drained[2].payload.type).toBe("permission_request");
      expect(drained[3].payload.type).toBe("result");
      expect(drained[4].payload.type).toBe("session_init");
      expect(drained[5].payload.type).toBe("error");
    });

    it("isOverflowing is false below high water mark", () => {
      const channel = new ConsumerChannel({ highWaterMark: 5 });
      channel.enqueue(makeMsg(1, "stream_event"));
      channel.enqueue(makeMsg(2, "stream_event"));
      expect(channel.isOverflowing).toBe(false);
    });

    it("supports custom critical types", () => {
      const channel = new ConsumerChannel({
        highWaterMark: 1,
        maxQueueSize: 100,
        criticalTypes: ["stream_event"],
      });

      // Fill to high water mark
      channel.enqueue(makeMsg(1, "result"));

      // stream_event is now critical (custom), result is not
      channel.enqueue(makeMsg(2, "stream_event"));
      channel.enqueue(makeMsg(3, "result")); // dropped because result is not in custom critical list

      expect(channel.queueSize).toBe(2);
      const drained = channel.drain();
      expect(drained[1].payload.type).toBe("stream_event");
    });
  });

  // -----------------------------------------------------------------------
  // Overflow detection
  // -----------------------------------------------------------------------

  describe("overflow detection", () => {
    it("returns false when maxQueueSize exceeded", () => {
      const channel = new ConsumerChannel({ highWaterMark: 100, maxQueueSize: 3 });

      expect(channel.enqueue(makeMsg(1, "result"))).toBe(true);
      expect(channel.enqueue(makeMsg(2, "result"))).toBe(true);
      expect(channel.enqueue(makeMsg(3, "result"))).toBe(true);

      // Queue is full — enqueue should return false
      expect(channel.enqueue(makeMsg(4, "result"))).toBe(false);
      expect(channel.queueSize).toBe(3);
    });

    it("returns false for critical messages at max too", () => {
      const channel = new ConsumerChannel({ highWaterMark: 100, maxQueueSize: 2 });

      channel.enqueue(makeMsg(1, "stream_event"));
      channel.enqueue(makeMsg(2, "stream_event"));

      // Even critical messages can't be enqueued past maxQueueSize
      expect(channel.enqueue(makeMsg(3, "permission_request"))).toBe(false);
    });

    it("resumes accepting after drain", () => {
      const channel = new ConsumerChannel({ highWaterMark: 100, maxQueueSize: 2 });

      channel.enqueue(makeMsg(1, "stream_event"));
      channel.enqueue(makeMsg(2, "stream_event"));
      expect(channel.enqueue(makeMsg(3, "stream_event"))).toBe(false);

      channel.drain();
      expect(channel.enqueue(makeMsg(4, "stream_event"))).toBe(true);
      expect(channel.queueSize).toBe(1);
    });
  });
});
