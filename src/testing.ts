/**
 * Public test utilities — exported from the `"beamcode/testing"` entry point.
 * Consumers can import these helpers to write integration tests against BeamCode.
 */
export { MemoryStorage } from "./adapters/memory-storage.js";
export { MockProcessManager } from "./testing/mock-process-manager.js";
export { createMockSocket } from "./testing/mock-socket.js";
export { NoopLogger, noopLogger } from "./utils/noop-logger.js";
