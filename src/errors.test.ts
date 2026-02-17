import { describe, expect, it } from "vitest";
import {
  BeamCodeError,
  errorMessage,
  ProcessError,
  StorageError,
  toBeamCodeError,
} from "./errors.js";

describe("BeamCodeError hierarchy", () => {
  it("BeamCodeError is an Error with code", () => {
    const err = new BeamCodeError("test", "TEST_ERROR");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BeamCodeError");
    expect(err.code).toBe("TEST_ERROR");
    expect(err.message).toBe("test");
  });

  it("domain errors have correct codes and extend BeamCodeError", () => {
    const storage = new StorageError("write failed");
    expect(storage).toBeInstanceOf(BeamCodeError);
    expect(storage).toBeInstanceOf(Error);
    expect(storage.code).toBe("STORAGE");
    expect(storage.name).toBe("StorageError");

    const proc = new ProcessError("spawn failed");
    expect(proc).toBeInstanceOf(BeamCodeError);
    expect(proc.code).toBe("PROCESS");
    expect(proc.name).toBe("ProcessError");
  });

  it("preserves cause chain", () => {
    const cause = new Error("original");
    const err = new StorageError("write failed", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("toBeamCodeError", () => {
  it("passes through BeamCodeError unchanged", () => {
    const err = new BeamCodeError("x", "X");
    expect(toBeamCodeError(err)).toBe(err);
  });

  it("wraps plain Error with cause chain", () => {
    const plain = new Error("plain");
    const wrapped = toBeamCodeError(plain);
    expect(wrapped).toBeInstanceOf(BeamCodeError);
    expect(wrapped.message).toBe("plain");
    expect(wrapped.cause).toBe(plain);
  });

  it("wraps non-Error values", () => {
    expect(toBeamCodeError("string error").message).toBe("string error");
    expect(toBeamCodeError(42).message).toBe("42");
    expect(toBeamCodeError(null).message).toBe("Unknown error");
    expect(toBeamCodeError(undefined).message).toBe("Unknown error");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new BeamCodeError("typed", "T"))).toBe("typed");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("string error")).toBe("string error");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("Unknown error");
    expect(errorMessage(undefined)).toBe("Unknown error");
  });
});
