import { describe, expect, it } from "vitest";
import type { SequencedMessage } from "../core/types/sequenced-message.js";
import { MessageSequencer } from "../core/types/sequenced-message.js";
import { EncryptionLayer } from "../relay/encryption-layer.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import { generateKeypair } from "../utils/crypto/key-manager.js";
import { ReconnectionHandler } from "./reconnection-handler.js";

/** Create a paired daemon/consumer EncryptionLayer set. */
async function setupPair(sessionId = "recon-session") {
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

describe("Reconnection through Encryption (integration)", () => {
  // -----------------------------------------------------------------------
  // 1. Encrypted messages survive reconnection replay
  // -----------------------------------------------------------------------

  describe("encrypted messages survive reconnection replay", () => {
    it("replayed encrypted messages decrypt correctly", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      handler.registerConsumer(sessionId);

      // Daemon encrypts 5 messages and records them
      const plainMessages: ConsumerMessage[] = [];
      const encryptedWires: string[] = [];

      for (let i = 0; i < 5; i++) {
        const msg: ConsumerMessage = {
          type: "user_message",
          content: `msg-${i}`,
          timestamp: Date.now() + i,
        };
        plainMessages.push(msg);

        const wire = await daemonLayer.encryptOutbound(msg);
        encryptedWires.push(wire);

        // Record the plaintext sequenced message for replay tracking
        const sequenced = sequencer.next(msg);
        handler.recordMessage(sessionId, sequenced);
      }

      // Consumer received messages 0-2 (seq 1-3), then disconnected
      // On reconnect, replay messages 4-5 (seq 4-5) in encrypted form
      const replay = handler.getReplayMessages(sessionId, 3);
      expect(replay).toHaveLength(2);
      expect(replay[0].seq).toBe(4);
      expect(replay[1].seq).toBe(5);

      // Re-encrypt the replayed messages and verify consumer can decrypt
      for (let i = 0; i < replay.length; i++) {
        const wire = await daemonLayer.encryptOutbound(replay[i].payload);
        const decrypted = await consumerLayer.decryptInbound(wire);
        expect(decrypted).toEqual(replay[i].payload);
      }
    });

    it("replayed messages maintain original content integrity", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      handler.registerConsumer(sessionId);

      // Record a complex assistant message
      const complexMsg: ConsumerMessage = {
        type: "assistant",
        message: {
          id: "msg-complex",
          type: "message",
          role: "assistant",
          model: "claude-4",
          content: [
            { type: "text", text: "Here is the result" },
            { type: "tool_use", id: "tu-1", name: "bash", input: { command: "ls" } },
          ],
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

      const sequenced = sequencer.next(complexMsg);
      handler.recordMessage(sessionId, sequenced);

      // Replay and verify through encryption
      const replay = handler.getReplayMessages(sessionId, 0);
      const wire = await daemonLayer.encryptOutbound(replay[0].payload);
      const decrypted = await consumerLayer.decryptInbound(wire);
      expect(decrypted).toEqual(complexMsg);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Sequence numbers preserved through encryption
  // -----------------------------------------------------------------------

  describe("sequence numbers preserved through encryption", () => {
    it("sequence numbers survive encrypt → decrypt roundtrip", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const handler = new ReconnectionHandler();
      const sessionId = "recon-session";

      handler.registerConsumer(sessionId);

      // Create sequenced messages
      const sequencedMessages: SequencedMessage<ConsumerMessage>[] = [];
      for (let i = 0; i < 5; i++) {
        const msg: ConsumerMessage = {
          type: "status_change",
          status: i % 2 === 0 ? "running" : "idle",
        };
        const sequenced = sequencer.next(msg);
        sequencedMessages.push(sequenced);
        handler.recordMessage(sessionId, sequenced);
      }

      // Encrypt the full sequenced messages (wrapping envelope)
      for (const seqMsg of sequencedMessages) {
        // Encrypt just the payload
        const wire = await daemonLayer.encryptOutbound(seqMsg.payload);
        const decrypted = await consumerLayer.decryptInbound(wire);

        // The decrypted payload matches the original
        expect(decrypted).toEqual(seqMsg.payload);
      }

      // Verify ReconnectionHandler correctly identifies replay based on lastSeq
      const replayFrom2 = handler.getReplayMessages(sessionId, 2);
      expect(replayFrom2).toHaveLength(3);
      expect(replayFrom2[0].seq).toBe(3);
      expect(replayFrom2[1].seq).toBe(4);
      expect(replayFrom2[2].seq).toBe(5);

      const replayFrom4 = handler.getReplayMessages(sessionId, 4);
      expect(replayFrom4).toHaveLength(1);
      expect(replayFrom4[0].seq).toBe(5);

      const replayFromAll = handler.getReplayMessages(sessionId, 5);
      expect(replayFromAll).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Re-pairing invalidates replay
  // -----------------------------------------------------------------------

  describe("re-pairing invalidates replay", () => {
    it("stored encrypted messages fail decryption after re-pairing", async () => {
      const { daemon, daemonLayer, consumerLayer } = await setupPair();
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      handler.registerConsumer(sessionId);

      // Encrypt messages with key pair A and store the wire format
      const encryptedWires: string[] = [];
      for (let i = 0; i < 3; i++) {
        const msg: ConsumerMessage = {
          type: "user_message",
          content: `msg-${i}`,
          timestamp: Date.now() + i,
        };
        const sequenced = sequencer.next(msg);
        handler.recordMessage(sessionId, sequenced);

        const wire = await daemonLayer.encryptOutbound(msg);
        encryptedWires.push(wire);
      }

      // Re-pair with key pair B
      const newConsumer = await generateKeypair();
      daemonLayer.updatePeerKey(newConsumer.publicKey);

      const newConsumerLayer = new EncryptionLayer({
        keypair: newConsumer,
        peerPublicKey: daemon.publicKey,
        sessionId: "recon-session",
      });

      // Old encrypted wires cannot be decrypted by new consumer — clean error
      for (const wire of encryptedWires) {
        await expect(newConsumerLayer.decryptInbound(wire)).rejects.toThrow();
      }

      // Old consumer also cannot decrypt new messages from re-paired daemon
      const newMsg: ConsumerMessage = { type: "cli_connected" };
      const newWire = await daemonLayer.encryptOutbound(newMsg);
      await expect(consumerLayer.decryptInbound(newWire)).rejects.toThrow();

      // But new consumer CAN decrypt new messages
      const decrypted = await newConsumerLayer.decryptInbound(newWire);
      expect(decrypted).toEqual(newMsg);
    });

    it("replayed plaintext payloads can be re-encrypted with new keys", async () => {
      const { daemon, daemonLayer } = await setupPair();
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      handler.registerConsumer(sessionId);

      // Record plaintext messages
      for (let i = 0; i < 3; i++) {
        const msg: ConsumerMessage = {
          type: "user_message",
          content: `msg-${i}`,
          timestamp: Date.now() + i,
        };
        handler.recordMessage(sessionId, sequencer.next(msg));
      }

      // Re-pair
      const newConsumer = await generateKeypair();
      daemonLayer.updatePeerKey(newConsumer.publicKey);

      const newConsumerLayer = new EncryptionLayer({
        keypair: newConsumer,
        peerPublicKey: daemon.publicKey,
        sessionId: "recon-session",
      });

      // Replay plaintext payloads and re-encrypt with new keys
      const replay = handler.getReplayMessages(sessionId, 0);
      expect(replay).toHaveLength(3);

      for (const seqMsg of replay) {
        const wire = await daemonLayer.encryptOutbound(seqMsg.payload);
        const decrypted = await newConsumerLayer.decryptInbound(wire);
        expect(decrypted).toEqual(seqMsg.payload);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Consumer reconnects with stable ID
  // -----------------------------------------------------------------------

  describe("consumer reconnects with stable ID", () => {
    it("full reconnection flow: connect → send → disconnect → reconnect → replay", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      // First connection
      const consumerId = handler.registerConsumer(sessionId);

      // Send 5 encrypted messages
      const allMessages: ConsumerMessage[] = [];
      for (let i = 0; i < 5; i++) {
        const msg: ConsumerMessage = {
          type: "user_message",
          content: `msg-${i}`,
          timestamp: Date.now() + i,
        };
        allMessages.push(msg);

        const sequenced = sequencer.next(msg);
        handler.recordMessage(sessionId, sequenced);
      }

      // Consumer received messages 0-2 (seq 1-3)
      handler.updateLastSeen(consumerId, 3);

      // --- Disconnect ---

      // --- Reconnect with same stableConsumerId ---
      const reconnectedId = handler.registerConsumer(sessionId, consumerId);
      expect(reconnectedId).toBe(consumerId);

      // Get missed messages
      const lastSeen = handler.getLastSeen(consumerId);
      expect(lastSeen).toBe(3);

      const replay = handler.getReplayMessages(sessionId, lastSeen);
      expect(replay).toHaveLength(2);
      expect(replay[0].seq).toBe(4);
      expect(replay[1].seq).toBe(5);

      // Re-encrypt and send missed messages to consumer
      for (let i = 0; i < replay.length; i++) {
        const wire = await daemonLayer.encryptOutbound(replay[i].payload);
        const decrypted = await consumerLayer.decryptInbound(wire);
        expect(decrypted).toEqual(allMessages[i + 3]);
      }
    });

    it("new consumer gets initial messages, not full replay", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();
      const handler = new ReconnectionHandler({ initialReplayCount: 3 });
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      // Record 10 messages
      for (let i = 0; i < 10; i++) {
        const msg: ConsumerMessage = {
          type: "user_message",
          content: `msg-${i}`,
          timestamp: Date.now() + i,
        };
        handler.recordMessage(sessionId, sequencer.next(msg));
      }

      // Brand-new consumer gets only the last 3
      const initial = handler.getInitialMessages(sessionId);
      expect(initial).toHaveLength(3);
      expect(initial[0].seq).toBe(8);
      expect(initial[1].seq).toBe(9);
      expect(initial[2].seq).toBe(10);

      // Verify those initial messages can be encrypted and decrypted
      for (const seqMsg of initial) {
        const wire = await daemonLayer.encryptOutbound(seqMsg.payload);
        const decrypted = await consumerLayer.decryptInbound(wire);
        expect(decrypted).toEqual(seqMsg.payload);
      }
    });

    it("multiple reconnections with advancing lastSeen", async () => {
      const { daemonLayer, consumerLayer } = await setupPair();
      const handler = new ReconnectionHandler();
      const sequencer = new MessageSequencer<ConsumerMessage>();
      const sessionId = "recon-session";

      const consumerId = handler.registerConsumer(sessionId);

      // Send 10 messages
      for (let i = 0; i < 10; i++) {
        const msg: ConsumerMessage = {
          type: "status_change",
          status: i % 2 === 0 ? "running" : "idle",
        };
        handler.recordMessage(sessionId, sequencer.next(msg));
      }

      // First disconnect at seq 3
      handler.updateLastSeen(consumerId, 3);
      let replay = handler.getReplayMessages(sessionId, handler.getLastSeen(consumerId));
      expect(replay).toHaveLength(7);

      // Verify encryption works on replayed messages
      for (const seqMsg of replay) {
        const wire = await daemonLayer.encryptOutbound(seqMsg.payload);
        const decrypted = await consumerLayer.decryptInbound(wire);
        expect(decrypted).toEqual(seqMsg.payload);
      }

      // Second disconnect at seq 7
      handler.updateLastSeen(consumerId, 7);
      handler.registerConsumer(sessionId, consumerId);
      replay = handler.getReplayMessages(sessionId, handler.getLastSeen(consumerId));
      expect(replay).toHaveLength(3);
      expect(replay[0].seq).toBe(8);

      // Third disconnect at seq 10 — nothing to replay
      handler.updateLastSeen(consumerId, 10);
      replay = handler.getReplayMessages(sessionId, handler.getLastSeen(consumerId));
      expect(replay).toHaveLength(0);
    });
  });
});
