import { describe, expect, it } from "vitest";
import { CONSUMER_PROTOCOL_VERSION as SHARED_CONSUMER_PROTOCOL_VERSION } from "../../shared/consumer-types.js";
import { CONSUMER_PROTOCOL_VERSION, type ConsumerMessage } from "./consumer-messages.js";

describe("consumer protocol version", () => {
  it("keeps shared and core protocol version in sync", () => {
    expect(CONSUMER_PROTOCOL_VERSION).toBe(SHARED_CONSUMER_PROTOCOL_VERSION);
  });

  it("allows session_init envelopes to carry protocol version", () => {
    const msg: ConsumerMessage = {
      type: "session_init",
      session: {
        session_id: "s1",
        model: "test",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
      },
      protocol_version: CONSUMER_PROTOCOL_VERSION,
    };
    expect(msg.protocol_version).toBe(CONSUMER_PROTOCOL_VERSION);
  });
});
