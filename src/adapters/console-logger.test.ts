import { describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "./console-logger.js";

describe("ConsoleLogger", () => {
  it("uses default prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("hello");
    expect(spy).toHaveBeenCalledWith("[claude-ws] hello");

    spy.mockRestore();
  });

  it("uses custom prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger("my-app");

    logger.info("test");
    expect(spy).toHaveBeenCalledWith("[my-app] test");

    spy.mockRestore();
  });

  it("debug() calls console.debug", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.debug("debug msg");
    expect(spy).toHaveBeenCalledWith("[claude-ws] debug msg");

    spy.mockRestore();
  });

  it("info() calls console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("info msg");
    expect(spy).toHaveBeenCalledWith("[claude-ws] info msg");

    spy.mockRestore();
  });

  it("warn() calls console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.warn("warn msg");
    expect(spy).toHaveBeenCalledWith("[claude-ws] warn msg");

    spy.mockRestore();
  });

  it("error() calls console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.error("error msg");
    expect(spy).toHaveBeenCalledWith("[claude-ws] error msg");

    spy.mockRestore();
  });

  it("passes context object when provided", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const ctx = { sessionId: "abc", code: 42 };

    logger.warn("with context", ctx);
    expect(spy).toHaveBeenCalledWith("[claude-ws] with context", ctx);

    spy.mockRestore();
  });

  it("omits context argument when not provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.error("no context");
    expect(spy).toHaveBeenCalledWith("[claude-ws] no context");
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
