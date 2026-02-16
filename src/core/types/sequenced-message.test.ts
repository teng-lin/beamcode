import { describe, expect, it } from "vitest";
import { MessageSequencer } from "./sequenced-message.js";

describe("MessageSequencer", () => {
  // -----------------------------------------------------------------------
  // Monotonic sequencing
  // -----------------------------------------------------------------------

  describe("monotonic sequencing", () => {
    it("starts at seq 1", () => {
      const sequencer = new MessageSequencer<string>();
      const msg = sequencer.next("hello");
      expect(msg.seq).toBe(1);
    });

    it("produces monotonically increasing sequence numbers", () => {
      const sequencer = new MessageSequencer<string>();
      const seqs: number[] = [];
      for (let i = 0; i < 100; i++) {
        seqs.push(sequencer.next(`msg-${i}`).seq);
      }
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }
    });

    it("currentSeq reflects last assigned number", () => {
      const sequencer = new MessageSequencer<number>();
      expect(sequencer.currentSeq).toBe(0);
      sequencer.next(42);
      expect(sequencer.currentSeq).toBe(1);
      sequencer.next(43);
      expect(sequencer.currentSeq).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Message fields
  // -----------------------------------------------------------------------

  describe("message fields", () => {
    it("wraps the payload correctly", () => {
      const sequencer = new MessageSequencer<{ value: number }>();
      const msg = sequencer.next({ value: 99 });
      expect(msg.payload).toEqual({ value: 99 });
    });

    it("assigns a unique message_id", () => {
      const sequencer = new MessageSequencer<string>();
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(sequencer.next("x").message_id);
      }
      expect(ids.size).toBe(50);
    });

    it("assigns a timestamp", () => {
      const before = Date.now();
      const sequencer = new MessageSequencer<string>();
      const msg = sequencer.next("hello");
      const after = Date.now();
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("resets sequence counter to zero", () => {
      const sequencer = new MessageSequencer<string>();
      sequencer.next("a");
      sequencer.next("b");
      expect(sequencer.currentSeq).toBe(2);

      sequencer.reset();
      expect(sequencer.currentSeq).toBe(0);
    });

    it("restarts sequence from 1 after reset", () => {
      const sequencer = new MessageSequencer<string>();
      sequencer.next("a");
      sequencer.next("b");
      sequencer.next("c");
      sequencer.reset();

      const msg = sequencer.next("d");
      expect(msg.seq).toBe(1);
      expect(msg.payload).toBe("d");
    });
  });
});
