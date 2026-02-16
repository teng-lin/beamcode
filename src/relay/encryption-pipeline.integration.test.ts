import { describe, expect, it } from "vitest";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import { generateKeypair } from "../utils/crypto/key-manager.js";
import { EncryptionLayer } from "./encryption-layer.js";

/** Create a paired daemon/consumer EncryptionLayer set. */
async function setupPair(sessionId = "integration-session") {
  const daemon = await generateKeypair();
  const consumer = await generateKeypair();

  const daemonLayer = new EncryptionLayer({
    keypair: daemon,
    peerPublicKey: consumer.publicKey,
    sessionId,
  });

  const consumerLayer = new EncryptionLayer({
    keypair: consumer,
    peerPublicKey: daemon.publicKey,
    sessionId,
  });

  return { daemon, consumer, daemonLayer, consumerLayer };
}

describe("Encryption Pipeline (integration)", () => {
  // -----------------------------------------------------------------------
  // 1. Pairing → crypto_box transition
  // -----------------------------------------------------------------------

  describe("pairing → crypto_box transition", () => {
    it("bidirectional encrypt/decrypt after pairing", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      // Daemon → Consumer
      const outbound: ConsumerMessage = { type: "cli_connected" };
      const wire = await daemonLayer.encryptOutbound(outbound);
      const decrypted = await consumerLayer.decryptInbound(wire);
      expect(decrypted).toEqual(outbound);

      // Consumer → Daemon
      const inbound: InboundMessage = { type: "user_message", content: "hello" };
      const inboundWire = await consumerLayer.encryptOutbound(
        inbound as unknown as ConsumerMessage,
      );
      const decryptedInbound = await daemonLayer.decryptInbound(inboundWire);
      expect(decryptedInbound).toEqual(inbound);
    });

    it("isEncrypted distinguishes encrypted vs plaintext", async () => {
      const { daemonLayer } = await setupPair();

      const encrypted = await daemonLayer.encryptOutbound({ type: "cli_connected" });
      expect(EncryptionLayer.isEncrypted(encrypted)).toBe(true);
      expect(EncryptionLayer.isEncrypted(JSON.stringify({ type: "cli_connected" }))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Multi-message sequence
  // -----------------------------------------------------------------------

  describe("multi-message sequence", () => {
    it("sends 15 messages through the pipeline in order", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      const messages: ConsumerMessage[] = [];
      for (let i = 0; i < 15; i++) {
        messages.push({
          type: "user_message",
          content: `message-${i}`,
          timestamp: Date.now() + i,
        });
      }

      const encrypted = await Promise.all(messages.map((msg) => daemonLayer.encryptOutbound(msg)));

      // Decrypt sequentially to verify ordering
      for (let i = 0; i < encrypted.length; i++) {
        const decrypted = await consumerLayer.decryptInbound(encrypted[i]);
        expect(decrypted.type).toBe("user_message");
        expect((decrypted as { type: "user_message"; content: string }).content).toBe(
          `message-${i}`,
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // 3. Message tampering detection
  // -----------------------------------------------------------------------

  describe("message tampering detection", () => {
    it("detects modified ciphertext", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      const msg: ConsumerMessage = { type: "cli_connected" };
      const wire = await daemonLayer.encryptOutbound(msg);

      // Parse the envelope and tamper with the ciphertext
      const envelope = JSON.parse(wire);
      const ciphertextBytes = Buffer.from(envelope.ct, "base64");
      // Flip a byte in the middle
      ciphertextBytes[Math.floor(ciphertextBytes.length / 2)] ^= 0xff;
      envelope.ct = ciphertextBytes.toString("base64");

      const tampered = JSON.stringify(envelope);
      await expect(consumerLayer.decryptInbound(tampered)).rejects.toThrow();
    });

    it("detects modified nonce (embedded in ct)", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      const msg: ConsumerMessage = { type: "cli_connected" };
      const wire = await daemonLayer.encryptOutbound(msg);

      // The nonce is prepended to the ciphertext in the ct field (base64url).
      // Tamper with the first byte (part of the nonce).
      const envelope = JSON.parse(wire);
      const { getSodium } = await import("../utils/crypto/sodium-loader.js");
      const sodium = await getSodium();
      const combined = sodium.from_base64(envelope.ct, sodium.base64_variants.URLSAFE_NO_PADDING);
      combined[0] ^= 0xff; // flip a nonce byte
      envelope.ct = sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING);

      const tampered = JSON.stringify(envelope);
      await expect(consumerLayer.decryptInbound(tampered)).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // 4. Stale key rejection
  // -----------------------------------------------------------------------

  describe("stale key rejection", () => {
    it("old messages cannot be decrypted after re-pairing", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      // Encrypt with original key pair
      const msg: ConsumerMessage = { type: "cli_connected" };
      const _wire = await daemonLayer.encryptOutbound(msg);

      // Re-pair with a brand new consumer
      const newConsumer = await generateKeypair();
      daemonLayer.updatePeerKey(newConsumer.publicKey);

      // Create a new consumer layer with the new keypair
      const _newConsumerLayer = new EncryptionLayer({
        keypair: newConsumer,
        peerPublicKey: (await setupPair()).daemon.publicKey, // different daemon
        sessionId: "integration-session",
      });

      // Old consumer cannot decrypt new messages from re-paired daemon
      const newMsg: ConsumerMessage = { type: "cli_disconnected" };
      const newWire = await daemonLayer.encryptOutbound(newMsg);
      await expect(consumerLayer.decryptInbound(newWire)).rejects.toThrow();

      // Original wire cannot be decrypted by daemon after peer key changed
      // (since daemon now expects messages from newConsumer, not old consumer)
      const inbound: InboundMessage = { type: "user_message", content: "test" };
      const oldConsumerWire = await consumerLayer.encryptOutbound(
        inbound as unknown as ConsumerMessage,
      );
      await expect(daemonLayer.decryptInbound(oldConsumerWire)).rejects.toThrow();
    });

    it("new key pair works after re-pairing", async () => {
      const { daemon, daemonLayer } = await setupPair();

      const newConsumer = await generateKeypair();
      daemonLayer.updatePeerKey(newConsumer.publicKey);

      const newConsumerLayer = new EncryptionLayer({
        keypair: newConsumer,
        peerPublicKey: daemon.publicKey,
        sessionId: "integration-session",
      });

      // New pair should work
      const msg: ConsumerMessage = { type: "cli_connected" };
      const wire = await daemonLayer.encryptOutbound(msg);
      const decrypted = await newConsumerLayer.decryptInbound(wire);
      expect(decrypted).toEqual(msg);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Revocation prevents all communication
  // -----------------------------------------------------------------------

  describe("revocation prevents all communication", () => {
    it("both encrypt and decrypt throw after deactivation", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      // Encrypt a message before deactivation for later use
      const msg: ConsumerMessage = { type: "cli_connected" };
      const wire = await daemonLayer.encryptOutbound(msg);

      // Deactivate both sides
      daemonLayer.deactivate();
      consumerLayer.deactivate();

      expect(daemonLayer.isActive()).toBe(false);
      expect(consumerLayer.isActive()).toBe(false);

      // Encrypt should throw on both sides
      await expect(daemonLayer.encryptOutbound(msg)).rejects.toThrow("deactivated");
      await expect(consumerLayer.encryptOutbound(msg)).rejects.toThrow("deactivated");

      // Decrypt should throw on both sides
      await expect(daemonLayer.decryptInbound(wire)).rejects.toThrow("deactivated");
      await expect(consumerLayer.decryptInbound(wire)).rejects.toThrow("deactivated");
    });
  });

  // -----------------------------------------------------------------------
  // 6. Mixed message types
  // -----------------------------------------------------------------------

  describe("mixed message types", () => {
    it("roundtrips all ConsumerMessage types", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      const messages: ConsumerMessage[] = [
        { type: "cli_connected" },
        { type: "cli_disconnected" },
        { type: "status_change", status: "running" },
        { type: "status_change", status: "idle" },
        { type: "error", message: "something went wrong" },
        { type: "session_name_update", name: "my-session" },
        { type: "permission_cancelled", request_id: "req-1" },
        {
          type: "user_message",
          content: "hello",
          timestamp: 1234567890,
        },
        {
          type: "tool_progress",
          tool_use_id: "tu-1",
          tool_name: "bash",
          elapsed_time_seconds: 5,
        },
        {
          type: "tool_use_summary",
          summary: "ran a command",
          tool_use_ids: ["tu-1"],
        },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-4",
            content: [{ type: "text", text: "Hello!" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
        },
        {
          type: "result",
          data: {
            subtype: "success",
            is_error: false,
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0.01,
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
        {
          type: "slash_command_result",
          command: "/help",
          content: "available commands...",
          source: "emulated",
        },
        {
          type: "slash_command_error",
          command: "/bad",
          error: "unknown command",
        },
      ];

      for (const original of messages) {
        const wire = await daemonLayer.encryptOutbound(original);
        const decrypted = await consumerLayer.decryptInbound(wire);
        expect(decrypted).toEqual(original);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 7. Large message handling
  // -----------------------------------------------------------------------

  describe("large message handling", () => {
    it("handles a 10KB+ payload", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      // Create a message with ~15KB of content
      const largeContent = "x".repeat(15_000);
      const msg: ConsumerMessage = {
        type: "assistant",
        message: {
          id: "msg-large",
          type: "message",
          role: "assistant",
          model: "claude-4",
          content: [{ type: "text", text: largeContent }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1000,
            output_tokens: 5000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      };

      const wire = await daemonLayer.encryptOutbound(msg);
      const decrypted = await consumerLayer.decryptInbound(wire);
      expect(decrypted).toEqual(msg);
    });

    it("handles a 100KB payload", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();

      const largeText = "A".repeat(100_000);
      const msg: ConsumerMessage = {
        type: "assistant",
        message: {
          id: "msg-100k",
          type: "message",
          role: "assistant",
          model: "claude-4",
          content: [{ type: "text", text: largeText }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      };

      const wire = await daemonLayer.encryptOutbound(msg);
      const decrypted = await consumerLayer.decryptInbound(wire);
      expect(decrypted).toEqual(msg);
    });
  });
});
