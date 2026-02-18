import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect } from "vitest";
import * as vitestAxeMatchers from "vitest-axe/matchers";

expect.extend(vitestAxeMatchers);

// Node.js v25+ ships a built-in localStorage that shadows jsdom's
// implementation but requires --localstorage-file to work properly.
// Install a simple in-memory polyfill so tests can use the standard API.
if (
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage.getItem !== "function"
) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
});
