import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcCodec,
} from "./json-rpc.js";

const arbMethod = fc.stringMatching(/^[a-z./]+$/).filter((s) => s.length > 0);
const arbParams = fc.option(fc.jsonValue(), { nil: undefined });
const arbId = fc.oneof(fc.nat(), fc.string({ minLength: 1 }));

describe("JsonRpcCodec property tests", () => {
  it("encode → decode roundtrip preserves all request fields", () => {
    const codec = new JsonRpcCodec();
    fc.assert(
      fc.property(arbMethod, arbParams, (method, params) => {
        const { raw } = codec.createRequest(method, params);
        const decoded = codec.decode(codec.encode(raw));
        expect(decoded).toEqual(raw);
      }),
    );
  });

  it("encode → decode roundtrip preserves notification fields", () => {
    const codec = new JsonRpcCodec();
    fc.assert(
      fc.property(arbMethod, arbParams, (method, params) => {
        const notif = codec.createNotification(method, params);
        const decoded = codec.decode(codec.encode(notif));
        expect(decoded).toEqual(notif);
      }),
    );
  });

  it("encode → decode roundtrip preserves response fields", () => {
    const codec = new JsonRpcCodec();
    fc.assert(
      fc.property(arbId, fc.jsonValue(), (id, result) => {
        const resp = codec.createResponse(id, result);
        const decoded = codec.decode(codec.encode(resp));
        expect(decoded).toEqual(resp);
      }),
    );
  });

  it("type guards are mutually exclusive and exhaustive on decoded messages", () => {
    const codec = new JsonRpcCodec();
    fc.assert(
      fc.property(arbMethod, arbParams, (method, params) => {
        const messages = [
          codec.createRequest(method, params).raw,
          codec.createNotification(method, params),
          codec.createResponse(1, params),
        ];
        for (const msg of messages) {
          const decoded = codec.decode(codec.encode(msg));
          const guards = [
            isJsonRpcRequest(decoded),
            isJsonRpcResponse(decoded),
            isJsonRpcNotification(decoded),
          ];
          expect(guards.filter(Boolean).length).toBe(1);
        }
      }),
    );
  });

  it("createRequest IDs are strictly monotonically increasing", () => {
    const codec = new JsonRpcCodec();
    fc.assert(
      fc.property(fc.array(arbMethod, { minLength: 2, maxLength: 100 }), (methods) => {
        const ids = methods.map((m) => codec.createRequest(m).id);
        for (let i = 1; i < ids.length; i++) {
          expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
        }
      }),
    );
  });

  it("all encoded messages end with newline", () => {
    const codec = new JsonRpcCodec();
    fc.assert(
      fc.property(arbMethod, arbParams, arbId, (method, params, id) => {
        expect(codec.encode(codec.createRequest(method, params).raw)).toMatch(/\n$/);
        expect(codec.encode(codec.createNotification(method, params))).toMatch(/\n$/);
        expect(codec.encode(codec.createResponse(id, params))).toMatch(/\n$/);
      }),
    );
  });

  it("decode rejects non-2.0 versions", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== "2.0"),
        (version) => {
          const codec = new JsonRpcCodec();
          const json = JSON.stringify({ jsonrpc: version, method: "test" });
          expect(() => codec.decode(json)).toThrow("Invalid JSON-RPC version");
        },
      ),
    );
  });
});
