import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { SessionBridge } from "../core/session-bridge.js";
import { OriginValidator } from "../server/origin-validator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const UUID_1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const UUID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

let server: NodeWebSocketServer | null = null;
const openClients: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openClients) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  openClients.length = 0;
  if (server) {
    await server.close();
    server = null;
  }
});

/** Connect a WS client, wait for open, and track for cleanup. */
function connect(url: string, options?: { headers?: Record<string, string> }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    openClients.push(ws);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Collect the next `count` messages from a WS client (with timeout). */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve, _reject) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      // Resolve with whatever we have (for flexible assertions)
      resolve(messages);
    }, timeoutMs);
    const handler = (data: { toString(): string }) => {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
}

/** Wait for a single message matching a predicate. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: unknown) => boolean,
  timeoutMs = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
    const handler = (data: { toString(): string }) => {
      const parsed = JSON.parse(data.toString());
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}

/** Start a NodeWebSocketServer wired to a SessionBridge. */
async function startWiredServer(options?: {
  originValidator?: OriginValidator;
}): Promise<{ bridge: SessionBridge; port: number }> {
  const bridge = new SessionBridge({ config: { port: 3456 } });

  server = new NodeWebSocketServer({
    port: 0,
    originValidator: options?.originValidator,
  });

  await server.listen(
    // CLI connection handler
    (socket, sessionId) => {
      bridge.handleCLIOpen(socket, sessionId);
      socket.on("message", (data) => bridge.handleCLIMessage(sessionId, data));
      socket.on("close", () => bridge.handleCLIClose(sessionId));
    },
    // Consumer connection handler
    (socket, context) => {
      bridge.handleConsumerOpen(socket, context);
      socket.on("message", (data) => bridge.handleConsumerMessage(socket, context.sessionId, data));
      socket.on("close", () => bridge.handleConsumerClose(socket, context.sessionId));
    },
  );

  return { bridge, port: server.port! };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: WebSocket Server CLI+Consumer Bidirectional Flow", () => {
  // ── 1. CLI sends message, consumer receives it ──────────────────────────

  it("CLI sends assistant message, consumer receives it", async () => {
    const { port } = await startWiredServer();

    // Connect consumer first (will get session_init, identity, etc.)
    const consumer = await connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`);

    // Drain initial messages (identity, session_init, presence_update, cli_disconnected)
    await collectMessages(consumer, 4, 500);

    // Connect CLI
    const cli = await connect(`ws://localhost:${port}/ws/cli/${UUID_1}`);

    // Wait for consumer to receive cli_connected
    const cliConnectedPromise = waitForMessage(
      consumer,
      (m: unknown) => (m as { type: string }).type === "cli_connected",
    );
    await cliConnectedPromise;

    // CLI sends an assistant message (NDJSON format)
    const assistantPayload = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello from CLI" }],
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
    });
    cli.send(assistantPayload);

    // Consumer should receive the assistant message
    const msg = await waitForMessage(
      consumer,
      (m: unknown) => (m as { type: string }).type === "assistant",
    );
    expect((msg as { type: string }).type).toBe("assistant");
    expect((msg as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe(
      "Hello from CLI",
    );
  });

  // ── 2. Consumer sends user_message, CLI receives it ─────────────────────

  it("consumer sends user_message, CLI receives it", async () => {
    const { port } = await startWiredServer();

    // Connect CLI first
    const cli = await connect(`ws://localhost:${port}/ws/cli/${UUID_1}`);
    const cliMessages = collectMessages(cli, 2, 2000);

    // Connect consumer
    const consumer = await connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`);
    // Wait for initial handshake
    await collectMessages(consumer, 4, 500);

    // Consumer sends a user_message
    consumer.send(JSON.stringify({ type: "user_message", content: "What is 2+2?" }));

    // CLI should receive the forwarded message
    const received = await cliMessages;
    expect(received.length).toBeGreaterThan(0);

    // At least one message should be a "user" type (NDJSON forwarded)
    const parsed = received.map((m) => JSON.parse(m.trim()));
    const userMsg = parsed.find((m: unknown) => (m as { type: string }).type === "user");
    expect(userMsg).toBeDefined();
    expect((userMsg as { message: { content: string } }).message.content).toBe("What is 2+2?");
  });

  // ── 3. Multiple consumers receive broadcast ─────────────────────────────

  it("all consumers receive CLI broadcast", async () => {
    const { port } = await startWiredServer();

    // Connect 3 consumers
    const consumers = await Promise.all([
      connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`),
      connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`),
      connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`),
    ]);

    // Drain initial messages from all consumers
    await Promise.all(consumers.map((c) => collectMessages(c, 4, 500)));

    // Connect CLI
    const cli = await connect(`ws://localhost:${port}/ws/cli/${UUID_1}`);

    // Wait for all consumers to get cli_connected
    await Promise.all(
      consumers.map((c) =>
        waitForMessage(c, (m: unknown) => (m as { type: string }).type === "cli_connected"),
      ),
    );

    // CLI sends a result message
    cli.send(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 50,
        duration_api_ms: 40,
        num_turns: 1,
        total_cost_usd: 0.001,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );

    // All 3 consumers should receive the result
    const results = await Promise.all(
      consumers.map((c) =>
        waitForMessage(c, (m: unknown) => (m as { type: string }).type === "result"),
      ),
    );
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect((r as { type: string }).type).toBe("result");
    }
  });

  // ── 4. Session isolation E2E ────────────────────────────────────────────

  it("messages do not leak between sessions", async () => {
    const { port } = await startWiredServer();

    // Set up 2 separate sessions
    const consumer1 = await connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`);
    const consumer2 = await connect(`ws://localhost:${port}/ws/consumer/${UUID_2}`);

    // Drain initial messages
    await Promise.all([collectMessages(consumer1, 4, 500), collectMessages(consumer2, 4, 500)]);

    // Set up cli_connected listeners BEFORE connecting CLIs (avoid race)
    const cliConnected1 = waitForMessage(
      consumer1,
      (m: unknown) => (m as { type: string }).type === "cli_connected",
    );
    const cliConnected2 = waitForMessage(
      consumer2,
      (m: unknown) => (m as { type: string }).type === "cli_connected",
    );

    // Connect CLIs for both sessions
    const cli1 = await connect(`ws://localhost:${port}/ws/cli/${UUID_1}`);
    const _cli2 = await connect(`ws://localhost:${port}/ws/cli/${UUID_2}`);

    await Promise.all([cliConnected1, cliConnected2]);

    // Set up assistant listener on consumer1 BEFORE sending
    const assistantPromise = waitForMessage(
      consumer1,
      (m: unknown) => (m as { type: string }).type === "assistant",
    );

    // CLI-1 sends a message
    cli1.send(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-s1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Session 1 only" }],
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      }),
    );

    // Consumer-1 should receive the assistant message
    const msg1 = await assistantPromise;
    expect(msg1).toBeDefined();

    // Consumer-2 should NOT receive anything (collect with short timeout)
    const leaked = await collectMessages(consumer2, 1, 300);
    const assistantLeaks = leaked
      .map((m) => JSON.parse(m))
      .filter((m: unknown) => (m as { type: string }).type === "assistant");
    expect(assistantLeaks).toHaveLength(0);
  });

  // ── 5. Consumer disconnect and reconnect ────────────────────────────────

  it("reconnected consumer receives new messages", async () => {
    const { port } = await startWiredServer();

    // Connect CLI first
    const cli = await connect(`ws://localhost:${port}/ws/cli/${UUID_1}`);

    // Connect consumer (CLI already connected, so: identity, session_init, presence_update — 3 msgs)
    const consumer1 = await connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`);
    await collectMessages(consumer1, 3, 500);

    // Disconnect consumer
    consumer1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect a new consumer to same session
    const consumer2 = await connect(`ws://localhost:${port}/ws/consumer/${UUID_1}`);

    // Drain initial messages (identity, session_init, presence_update — CLI still connected)
    await collectMessages(consumer2, 3, 500);

    // Set up assistant listener BEFORE CLI sends
    const assistantPromise = waitForMessage(
      consumer2,
      (m: unknown) => (m as { type: string }).type === "assistant",
    );

    // CLI sends a new message
    cli.send(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-after-reconnect",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "After reconnect" }],
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      }),
    );

    // New consumer should receive the message
    const msg = await assistantPromise;
    expect((msg as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe(
      "After reconnect",
    );
  });

  // ── 6. Invalid session ID rejected ──────────────────────────────────────

  it("rejects CLI connection with non-UUID session ID", async () => {
    await startWiredServer();
    const port = server!.port!;

    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/not-a-uuid`);
    openClients.push(ws);

    const code = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    expect(code).toBe(1008);
  });

  it("rejects consumer connection with non-UUID session ID", async () => {
    await startWiredServer();
    const port = server!.port!;

    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/invalid-id`);
    openClients.push(ws);

    const code = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    expect(code).toBe(1008);
  });

  // ── 7. Origin validation E2E ────────────────────────────────────────────

  it("rejects connection from untrusted origin", async () => {
    const originValidator = new OriginValidator();
    await startWiredServer({ originValidator });
    const port = server!.port!;

    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${UUID_1}`, {
      headers: { origin: "https://evil.example.com" },
    });
    openClients.push(ws);

    const result = await new Promise<"error" | "open">((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("unexpected-response", () => resolve("error"));
    });

    expect(result).toBe("error");
  });

  it("accepts connection from localhost origin", async () => {
    const originValidator = new OriginValidator();
    await startWiredServer({ originValidator });
    const port = server!.port!;

    const ws = await connect(`ws://localhost:${port}/ws/cli/${UUID_1}`, {
      headers: { origin: "http://localhost:5173" },
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
