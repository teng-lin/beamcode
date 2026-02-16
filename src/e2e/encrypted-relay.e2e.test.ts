import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { EncryptionLayer } from "../relay/encryption-layer.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import { generateKeypair } from "../utils/crypto/key-manager.js";

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

let server: NodeWebSocketServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

/** Wait for a WebSocket client to open. */
function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

/** Collect the next N messages from a WebSocket client. */
function collectMessages(ws: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    ws.on("message", (data) => {
      messages.push(data.toString());
      if (messages.length >= count) resolve(messages);
    });
  });
}

/** Create paired EncryptionLayers and a server that echoes encrypted messages. */
async function setupEncryptedRelay() {
  const daemon = await generateKeypair();
  const consumer = await generateKeypair();

  const daemonLayer = new EncryptionLayer({
    keypair: daemon,
    peerPublicKey: consumer.publicKey,
    sessionId: TEST_SESSION_ID,
  });

  const consumerLayer = new EncryptionLayer({
    keypair: consumer,
    peerPublicKey: daemon.publicKey,
    sessionId: TEST_SESSION_ID,
  });

  return { daemon, consumer, daemonLayer, consumerLayer };
}

describe("Encrypted Relay E2E", () => {
  // -----------------------------------------------------------------------
  // 1. Full encrypted round-trip
  // -----------------------------------------------------------------------

  it("full encrypted round-trip through WebSocket", async () => {
    const { daemonLayer, consumerLayer } = await setupEncryptedRelay();

    server = new NodeWebSocketServer({ port: 0 });

    await server.listen(
      () => {},
      (socket, _context) => {
        socket.on("message", async (data: string | Buffer) => {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          // Decrypt the inbound consumer message
          const inbound = await daemonLayer.decryptInbound(raw);
          const msg = inbound as unknown as InboundMessage;
          expect(msg.type).toBe("user_message");

          // Send back an encrypted response
          const response: ConsumerMessage = {
            type: "assistant",
            message: {
              id: "resp-1",
              type: "message",
              role: "assistant",
              model: "claude-4",
              content: [{ type: "text", text: `Echo: ${(msg as { content: string }).content}` }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
            parent_tool_use_id: null,
          };
          const encrypted = await daemonLayer.encryptOutbound(response);
          socket.send(encrypted);
        });
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_SESSION_ID}`);
    const responsePromise = collectMessages(ws, 1);
    await waitOpen(ws);

    // Consumer encrypts and sends a user_message
    const outbound: InboundMessage = { type: "user_message", content: "hello server" };
    const encrypted = await consumerLayer.encryptOutbound(outbound as unknown as ConsumerMessage);
    ws.send(encrypted);

    // Wait for encrypted response, then decrypt
    const [responseWire] = await responsePromise;
    expect(EncryptionLayer.isEncrypted(responseWire)).toBe(true);

    const decrypted = await consumerLayer.decryptInbound(responseWire);
    expect(decrypted.type).toBe("assistant");
    const assistant = decrypted as ConsumerMessage & { type: "assistant" };
    const text = assistant.message.content[0];
    expect(text).toEqual({ type: "text", text: "Echo: hello server" });

    ws.close();
  });

  // -----------------------------------------------------------------------
  // 2. Multiple encrypted messages in sequence
  // -----------------------------------------------------------------------

  it("sends 10 encrypted messages and receives 10 correct responses", async () => {
    const { daemonLayer, consumerLayer } = await setupEncryptedRelay();

    server = new NodeWebSocketServer({ port: 0 });
    let msgIndex = 0;

    await server.listen(
      () => {},
      (socket, _context) => {
        socket.on("message", async (data: string | Buffer) => {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          const _inbound = await daemonLayer.decryptInbound(raw);
          const idx = msgIndex++;

          const response: ConsumerMessage = {
            type: "user_message",
            content: `reply-${idx}`,
            timestamp: Date.now(),
          };
          const encrypted = await daemonLayer.encryptOutbound(response);
          socket.send(encrypted);
        });
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_SESSION_ID}`);
    const responsePromise = collectMessages(ws, 10);
    await waitOpen(ws);

    // Send 10 encrypted messages
    for (let i = 0; i < 10; i++) {
      const msg: InboundMessage = { type: "user_message", content: `msg-${i}` };
      const encrypted = await consumerLayer.encryptOutbound(msg as unknown as ConsumerMessage);
      ws.send(encrypted);
    }

    // Verify all 10 responses
    const responses = await responsePromise;
    expect(responses).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      const decrypted = await consumerLayer.decryptInbound(responses[i]);
      expect(decrypted.type).toBe("user_message");
      expect((decrypted as { content: string }).content).toBe(`reply-${i}`);
    }

    ws.close();
  });

  // -----------------------------------------------------------------------
  // 3. Mixed encrypted + plaintext detection
  // -----------------------------------------------------------------------

  it("distinguishes encrypted vs plaintext messages", async () => {
    const { daemonLayer, consumerLayer } = await setupEncryptedRelay();

    server = new NodeWebSocketServer({ port: 0 });
    const detectedTypes: Array<"encrypted" | "plaintext"> = [];

    await server.listen(
      () => {},
      (socket, _context) => {
        socket.on("message", async (data: string | Buffer) => {
          const raw = typeof data === "string" ? data : data.toString("utf-8");

          if (EncryptionLayer.isEncrypted(raw)) {
            detectedTypes.push("encrypted");
            const _inbound = await daemonLayer.decryptInbound(raw);
            const response: ConsumerMessage = { type: "cli_connected" };
            const encrypted = await daemonLayer.encryptOutbound(response);
            socket.send(encrypted);
          } else {
            detectedTypes.push("plaintext");
            // Echo back plaintext
            socket.send(JSON.stringify({ type: "cli_connected" }));
          }
        });
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_SESSION_ID}`);
    const responsePromise = collectMessages(ws, 2);
    await waitOpen(ws);

    // Send one plaintext message
    ws.send(JSON.stringify({ type: "user_message", content: "plain" }));

    // Send one encrypted message
    const msg: InboundMessage = { type: "user_message", content: "encrypted" };
    const encrypted = await consumerLayer.encryptOutbound(msg as unknown as ConsumerMessage);
    ws.send(encrypted);

    const responses = await responsePromise;
    expect(responses).toHaveLength(2);

    // Verify detection
    expect(detectedTypes).toEqual(["plaintext", "encrypted"]);

    // First response is plaintext
    expect(EncryptionLayer.isEncrypted(responses[0])).toBe(false);
    expect(JSON.parse(responses[0])).toEqual({ type: "cli_connected" });

    // Second response is encrypted
    expect(EncryptionLayer.isEncrypted(responses[1])).toBe(true);
    const decrypted = await consumerLayer.decryptInbound(responses[1]);
    expect(decrypted).toEqual({ type: "cli_connected" });

    ws.close();
  });

  // -----------------------------------------------------------------------
  // 4. Wrong key rejection over WebSocket
  // -----------------------------------------------------------------------

  it("wrong key: server rejects and sends error back gracefully", async () => {
    // Consumer has key pair A, server expects key pair B
    const daemonKp = await generateKeypair();
    const consumerKp = await generateKeypair();
    const wrongConsumerKp = await generateKeypair();

    // Daemon is set up to expect wrongConsumerKp, not the real consumerKp
    const daemonLayer = new EncryptionLayer({
      keypair: daemonKp,
      peerPublicKey: wrongConsumerKp.publicKey, // wrong key!
      sessionId: TEST_SESSION_ID,
    });

    const consumerLayer = new EncryptionLayer({
      keypair: consumerKp,
      peerPublicKey: daemonKp.publicKey,
      sessionId: TEST_SESSION_ID,
    });

    server = new NodeWebSocketServer({ port: 0 });

    await server.listen(
      () => {},
      (socket, _context) => {
        socket.on("message", async (data: string | Buffer) => {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          try {
            await daemonLayer.decryptInbound(raw);
          } catch (err) {
            // Send error back as plaintext (graceful handling, no crash)
            const errorMsg: ConsumerMessage = {
              type: "error",
              message: `Decryption failed: ${(err as Error).message}`,
            };
            socket.send(JSON.stringify(errorMsg));
          }
        });
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_SESSION_ID}`);
    const responsePromise = collectMessages(ws, 1);
    await waitOpen(ws);

    // Consumer encrypts with their real key (which daemon doesn't expect)
    const msg: InboundMessage = { type: "user_message", content: "test" };
    const encrypted = await consumerLayer.encryptOutbound(msg as unknown as ConsumerMessage);
    ws.send(encrypted);

    // Server should send back an error message (not crash)
    const [response] = await responsePromise;
    const parsed = JSON.parse(response);
    expect(parsed.type).toBe("error");
    expect(parsed.message).toContain("Decryption failed");

    ws.close();
  });

  // -----------------------------------------------------------------------
  // 5. Deactivated layer over WebSocket
  // -----------------------------------------------------------------------

  it("deactivated layer: server sends error when encryption layer is deactivated", async () => {
    const { daemonLayer, consumerLayer } = await setupEncryptedRelay();

    server = new NodeWebSocketServer({ port: 0 });
    let messageCount = 0;

    await server.listen(
      () => {},
      (socket, _context) => {
        socket.on("message", async (data: string | Buffer) => {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          messageCount++;

          if (messageCount === 1) {
            // First message: process normally, then deactivate
            const _inbound = await daemonLayer.decryptInbound(raw);
            const response: ConsumerMessage = { type: "cli_connected" };
            const encrypted = await daemonLayer.encryptOutbound(response);
            socket.send(encrypted);

            // Deactivate encryption layer after first message
            daemonLayer.deactivate();
          } else {
            // Second message: layer is deactivated
            try {
              await daemonLayer.decryptInbound(raw);
            } catch (err) {
              const errorMsg: ConsumerMessage = {
                type: "error",
                message: (err as Error).message,
              };
              socket.send(JSON.stringify(errorMsg));
            }
          }
        });
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_SESSION_ID}`);
    await waitOpen(ws);

    // First message: should work
    const msg1: InboundMessage = { type: "user_message", content: "first" };
    const enc1 = await consumerLayer.encryptOutbound(msg1 as unknown as ConsumerMessage);
    const firstResponse = collectMessages(ws, 1);
    ws.send(enc1);

    // Wait for first response before sending second (deactivate happens after first)
    await firstResponse;

    // Second message: should fail because daemon layer is deactivated
    const msg2: InboundMessage = { type: "user_message", content: "second" };
    const enc2 = await consumerLayer.encryptOutbound(msg2 as unknown as ConsumerMessage);
    const secondResponse = collectMessages(ws, 1);
    ws.send(enc2);

    const responses = [...(await firstResponse), ...(await secondResponse)];

    // First response: successful encrypted response
    expect(EncryptionLayer.isEncrypted(responses[0])).toBe(true);
    const decrypted = await consumerLayer.decryptInbound(responses[0]);
    expect(decrypted).toEqual({ type: "cli_connected" });

    // Second response: plaintext error
    expect(EncryptionLayer.isEncrypted(responses[1])).toBe(false);
    const errorResponse = JSON.parse(responses[1]);
    expect(errorResponse.type).toBe("error");
    expect(errorResponse.message).toContain("deactivated");

    ws.close();
  });
});
