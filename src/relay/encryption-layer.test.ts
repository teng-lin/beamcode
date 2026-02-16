import { describe, expect, it } from "vitest";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import { generateKeypair } from "../utils/crypto/key-manager.js";
import { EncryptionLayer } from "./encryption-layer.js";

describe("EncryptionLayer", () => {
  async function setupPair() {
    const daemon = await generateKeypair();
    const consumer = await generateKeypair();

    const daemonLayer = new EncryptionLayer({
      keypair: daemon,
      peerPublicKey: consumer.publicKey,
      sessionId: "test-session",
    });

    const consumerLayer = new EncryptionLayer({
      keypair: consumer,
      peerPublicKey: daemon.publicKey,
      sessionId: "test-session",
    });

    return { daemon, consumer, daemonLayer, consumerLayer };
  }

  it("encrypt/decrypt roundtrip through mock tunnel", async () => {
    const { daemonLayer, consumerLayer } = await setupPair();

    // Daemon encrypts a ConsumerMessage
    const outbound: ConsumerMessage = {
      type: "status_change",
      status: "running",
    };
    const wire = await daemonLayer.encryptOutbound(outbound);
    expect(typeof wire).toBe("string");

    // Simulate sending over WebSocket — consumer decrypts
    // The consumer receives this as an EncryptedEnvelope (not InboundMessage),
    // but for the roundtrip test we decrypt and verify the content
    const parsed = JSON.parse(wire);
    expect(parsed.v).toBe(1);
    expect(parsed.sid).toBe("test-session");

    // Consumer side: encrypt an InboundMessage
    const inbound: InboundMessage = { type: "user_message", content: "hello" };
    const inboundWire = await consumerLayer.encryptOutbound(inbound as unknown as ConsumerMessage);

    // Daemon decrypts
    const decrypted = await daemonLayer.decryptInbound(inboundWire);
    expect(decrypted.type).toBe("user_message");
    expect((decrypted as { type: "user_message"; content: string }).content).toBe("hello");
  });

  it("rejects messages after deactivation", async () => {
    const { daemonLayer } = await setupPair();

    daemonLayer.deactivate();
    expect(daemonLayer.isActive()).toBe(false);

    const msg: ConsumerMessage = { type: "cli_connected" };
    await expect(daemonLayer.encryptOutbound(msg)).rejects.toThrow("deactivated");
    await expect(daemonLayer.decryptInbound("{}")).rejects.toThrow("deactivated");
  });

  it("rejects messages encrypted with stale key", async () => {
    const { daemonLayer, consumerLayer } = await setupPair();

    // Consumer encrypts with current key
    const msg: ConsumerMessage = { type: "cli_connected" };
    const wire = await consumerLayer.encryptOutbound(msg);

    // Daemon updates peer key (simulating re-pairing with different consumer)
    const newConsumer = await generateKeypair();
    daemonLayer.updatePeerKey(newConsumer.publicKey);

    // Old message should fail to decrypt
    await expect(daemonLayer.decryptInbound(wire)).rejects.toThrow();
  });

  it("revocation prevents messages", async () => {
    const { daemonLayer } = await setupPair();

    daemonLayer.deactivate();

    const msg: ConsumerMessage = { type: "cli_disconnected" };
    await expect(daemonLayer.encryptOutbound(msg)).rejects.toThrow("deactivated");
  });

  it("isEncrypted detects encrypted envelopes", async () => {
    const { daemonLayer } = await setupPair();

    const msg: ConsumerMessage = { type: "cli_connected" };
    const encrypted = await daemonLayer.encryptOutbound(msg);

    expect(EncryptionLayer.isEncrypted(encrypted)).toBe(true);
    expect(EncryptionLayer.isEncrypted('{"type":"cli_connected"}')).toBe(false);
    expect(EncryptionLayer.isEncrypted("not json")).toBe(false);
  });

  it("isEncrypted works with Buffer input", async () => {
    const { daemonLayer } = await setupPair();

    const msg: ConsumerMessage = { type: "cli_connected" };
    const encrypted = await daemonLayer.encryptOutbound(msg);
    const buf = Buffer.from(encrypted, "utf-8");

    expect(EncryptionLayer.isEncrypted(buf)).toBe(true);
  });

  it("handles complex ConsumerMessage", async () => {
    const { daemonLayer, consumerLayer } = await setupPair();

    const msg: ConsumerMessage = {
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-4",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    };

    const wire = await daemonLayer.encryptOutbound(msg);
    const decrypted = await consumerLayer.decryptInbound(wire);

    // The decrypted content should match the original
    expect(decrypted).toEqual(msg);
  });
});
