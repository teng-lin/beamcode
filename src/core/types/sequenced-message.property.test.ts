import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MessageSequencer } from "./sequenced-message.js";

describe("MessageSequencer property tests", () => {
  it("sequences are strictly monotonically increasing", () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 2, maxLength: 100 }), (payloads) => {
        const seq = new MessageSequencer();
        const messages = payloads.map((p) => seq.next(p));
        for (let i = 1; i < messages.length; i++) {
          expect(messages[i]!.seq).toBe(messages[i - 1]!.seq + 1);
        }
      }),
    );
  });

  it("first sequence after creation is always 1", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const seq = new MessageSequencer();
        expect(seq.next(payload).seq).toBe(1);
      }),
    );
  });

  it("first sequence after reset is always 1", () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 20 }),
        fc.jsonValue(),
        (warmup, payload) => {
          const seq = new MessageSequencer();
          for (const p of warmup) seq.next(p);
          seq.reset();
          expect(seq.next(payload).seq).toBe(1);
        },
      ),
    );
  });

  it("all message_ids are unique UUIDs", () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 2, maxLength: 200 }), (payloads) => {
        const seq = new MessageSequencer();
        const ids = new Set(payloads.map((p) => seq.next(p).message_id));
        expect(ids.size).toBe(payloads.length);
      }),
    );
  });

  it("payload is preserved through wrapping", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const seq = new MessageSequencer();
        expect(seq.next(payload).payload).toEqual(payload);
      }),
    );
  });

  it("currentSeq matches the last assigned sequence", () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 1, maxLength: 50 }), (payloads) => {
        const seq = new MessageSequencer();
        let last = 0;
        for (const p of payloads) last = seq.next(p).seq;
        expect(seq.currentSeq).toBe(last);
      }),
    );
  });
});
