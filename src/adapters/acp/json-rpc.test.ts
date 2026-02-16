import { describe, expect, it } from "vitest";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcCodec,
} from "./json-rpc.js";

describe("JsonRpcCodec", () => {
  const codec = new JsonRpcCodec();

  describe("createRequest", () => {
    it("creates request with auto-incrementing IDs", () => {
      const c = new JsonRpcCodec();
      const r1 = c.createRequest("session/prompt", { text: "hi" });
      const r2 = c.createRequest("session/set_model");

      expect(r1.id).toBe(1);
      expect(r1.raw.jsonrpc).toBe("2.0");
      expect(r1.raw.method).toBe("session/prompt");
      expect(r1.raw.params).toEqual({ text: "hi" });

      expect(r2.id).toBe(2);
      expect(r2.raw.method).toBe("session/set_model");
      expect(r2.raw.params).toBeUndefined();
    });
  });

  describe("createNotification", () => {
    it("creates notification without id", () => {
      const msg = codec.createNotification("session/cancel");

      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.method).toBe("session/cancel");
      expect("id" in msg).toBe(false);
    });

    it("includes params when provided", () => {
      const msg = codec.createNotification("session/update", { data: 42 });
      expect(msg.params).toEqual({ data: 42 });
    });
  });

  describe("createResponse", () => {
    it("creates success response", () => {
      const msg = codec.createResponse(1, { sessionId: "sess-1" });

      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id).toBe(1);
      expect(msg.result).toEqual({ sessionId: "sess-1" });
    });
  });

  describe("createErrorResponse", () => {
    it("creates error response", () => {
      const msg = codec.createErrorResponse(1, -32001, "Method not found");

      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id).toBe(1);
      expect(msg.error).toEqual({ code: -32001, message: "Method not found" });
    });
  });

  describe("encode", () => {
    it("encodes message as JSON with trailing newline", () => {
      const msg = codec.createNotification("session/cancel");
      const encoded = codec.encode(msg);

      expect(encoded.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(encoded);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("session/cancel");
    });
  });

  describe("decode", () => {
    it("decodes valid JSON-RPC request", () => {
      const line = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
      const msg = codec.decode(line);

      expect(isJsonRpcRequest(msg)).toBe(true);
    });

    it("decodes valid JSON-RPC notification", () => {
      const line = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"plan"}}';
      const msg = codec.decode(line);

      expect(isJsonRpcNotification(msg)).toBe(true);
    });

    it("decodes valid JSON-RPC response", () => {
      const line = '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}';
      const msg = codec.decode(line);

      expect(isJsonRpcResponse(msg)).toBe(true);
    });

    it("trims whitespace before parsing", () => {
      const line = '  {"jsonrpc":"2.0","id":1,"result":{}}  \n';
      const msg = codec.decode(line);
      expect(msg).toBeDefined();
    });

    it("throws on empty line", () => {
      expect(() => codec.decode("")).toThrow("Empty JSON-RPC message");
      expect(() => codec.decode("   ")).toThrow("Empty JSON-RPC message");
    });

    it("throws on invalid JSON", () => {
      expect(() => codec.decode("not json")).toThrow();
    });

    it("throws on wrong jsonrpc version", () => {
      expect(() => codec.decode('{"jsonrpc":"1.0","id":1}')).toThrow("Invalid JSON-RPC version");
    });
  });

  describe("roundtrip encode/decode", () => {
    it("request survives roundtrip", () => {
      const c = new JsonRpcCodec();
      const { raw } = c.createRequest("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      const decoded = c.decode(c.encode(raw));

      expect(isJsonRpcRequest(decoded)).toBe(true);
      if (isJsonRpcRequest(decoded)) {
        expect(decoded.method).toBe("session/prompt");
        expect(decoded.id).toBe(raw.id);
      }
    });
  });
});
