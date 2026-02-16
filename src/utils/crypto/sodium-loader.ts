/**
 * Sodium loader — initializes and caches the libsodium WASM build.
 *
 * Uses libsodium-wrappers-sumo which works everywhere without a C toolchain.
 * A future optimisation pass can add sodium-native (C addon) with a shim layer.
 */

import type libsodiumSumo from "libsodium-wrappers-sumo";

let cached: typeof libsodiumSumo | undefined;

/**
 * Returns an initialized libsodium instance.
 * The result is cached after the first successful call.
 */
export async function getSodium(): Promise<typeof libsodiumSumo> {
  if (cached) return cached;

  const sodium = (await import("libsodium-wrappers-sumo")).default;
  await sodium.ready;
  cached = sodium;
  return sodium;
}
