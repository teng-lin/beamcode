import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeypair } from "./key-manager.js";
import { PairingManager, parsePairingLink, sealPublicKeyForPairing } from "./pairing.js";

describe("PairingManager", () => {
  let manager: PairingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    manager = new PairingManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates a valid pairing link", async () => {
    const { link, expiresAt } = await manager.generatePairingLink("https://tunnel.example.com");

    expect(link).toContain("https://tunnel.example.com/pair?pk=");
    expect(link).toContain("&fp=");
    expect(link).toContain("&v=1");
    expect(expiresAt).toBe(Date.now() + 60_000);
    expect(manager.isPaired()).toBe(false);
    expect(manager.isExpired()).toBe(false);
  });

  it("strips trailing slash from tunnel URL", async () => {
    const { link } = await manager.generatePairingLink("https://tunnel.example.com/");
    expect(link).toMatch(/^https:\/\/tunnel\.example\.com\/pair\?/);
    expect(link).not.toContain("//pair");
  });

  it("happy path: end-to-end pairing", async () => {
    // Daemon generates pairing link
    const { link } = await manager.generatePairingLink("https://tunnel.example.com");

    // Consumer parses link, generates own keypair
    const parsed = await parsePairingLink(link);
    const consumerKp = await generateKeypair();

    // Consumer seals its public key for the daemon
    const sealed = await sealPublicKeyForPairing(consumerKp.publicKey, parsed.publicKey);

    // Daemon handles the pairing request
    const result = await manager.handlePairingRequest(sealed);

    expect(result.success).toBe(true);
    expect(result.peerPublicKey).toEqual(consumerKp.publicKey);
    expect(manager.isPaired()).toBe(true);
  });

  it("rejects pairing after 60s expiry", async () => {
    await manager.generatePairingLink("https://tunnel.example.com");
    const consumerKp = await generateKeypair();
    const daemonPk = manager.getKeypair()!.publicKey;
    const sealed = await sealPublicKeyForPairing(consumerKp.publicKey, daemonPk);

    // Advance past expiry
    vi.advanceTimersByTime(61_000);

    expect(manager.isExpired()).toBe(true);
    const result = await manager.handlePairingRequest(sealed);
    expect(result.success).toBe(false);
  });

  it("rejects double pairing (one-time use)", async () => {
    await manager.generatePairingLink("https://tunnel.example.com");
    const daemonPk = manager.getKeypair()!.publicKey;

    // First pairing succeeds
    const kp1 = await generateKeypair();
    const sealed1 = await sealPublicKeyForPairing(kp1.publicKey, daemonPk);
    const r1 = await manager.handlePairingRequest(sealed1);
    expect(r1.success).toBe(true);

    // Second pairing attempt is rejected
    const kp2 = await generateKeypair();
    const sealed2 = await sealPublicKeyForPairing(kp2.publicKey, daemonPk);
    const r2 = await manager.handlePairingRequest(sealed2);
    expect(r2.success).toBe(false);
  });

  it("rejects pairing with invalid sealed data", async () => {
    await manager.generatePairingLink("https://tunnel.example.com");
    const garbage = crypto.getRandomValues(new Uint8Array(64));
    const result = await manager.handlePairingRequest(garbage);
    expect(result.success).toBe(false);
  });

  it("rejects pairing when no keypair generated", async () => {
    const fresh = new PairingManager();
    const sealed = crypto.getRandomValues(new Uint8Array(64));
    const result = await fresh.handlePairingRequest(sealed);
    expect(result.success).toBe(false);
  });

  it("revocation destroys old key and generates new one", async () => {
    await manager.generatePairingLink("https://tunnel.example.com");
    const oldPk = manager.getKeypair()!.publicKey.slice();

    // Pair successfully
    const consumerKp = await generateKeypair();
    const sealed = await sealPublicKeyForPairing(consumerKp.publicKey, oldPk);
    await manager.handlePairingRequest(sealed);
    expect(manager.isPaired()).toBe(true);

    // Revoke
    await manager.revoke();

    expect(manager.isPaired()).toBe(false);
    expect(manager.getPeerPublicKey()).toBeNull();
    // New key is different from old
    const newPk = manager.getKeypair()!.publicKey;
    expect(newPk).not.toEqual(oldPk);
  });

  it("post-revocation pairing works with new keypair", async () => {
    // Initial pairing
    await manager.generatePairingLink("https://tunnel.example.com");
    const kp1 = await generateKeypair();
    const sealed1 = await sealPublicKeyForPairing(kp1.publicKey, manager.getKeypair()!.publicKey);
    await manager.handlePairingRequest(sealed1);

    // Revoke
    await manager.revoke();

    // Generate new pairing link (resets expiry + keypair)
    await manager.generatePairingLink("https://tunnel.example.com");

    // New consumer pairs successfully
    const kp2 = await generateKeypair();
    const sealed2 = await sealPublicKeyForPairing(kp2.publicKey, manager.getKeypair()!.publicKey);
    const result = await manager.handlePairingRequest(sealed2);
    expect(result.success).toBe(true);
    expect(result.peerPublicKey).toEqual(kp2.publicKey);
  });

  it("concurrent pairing: first wins, second fails", async () => {
    await manager.generatePairingLink("https://tunnel.example.com");
    const daemonPk = manager.getKeypair()!.publicKey;

    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const sealed1 = await sealPublicKeyForPairing(kp1.publicKey, daemonPk);
    const sealed2 = await sealPublicKeyForPairing(kp2.publicKey, daemonPk);

    // Race both requests
    const [r1, r2] = await Promise.all([
      manager.handlePairingRequest(sealed1),
      manager.handlePairingRequest(sealed2),
    ]);

    // Exactly one should succeed
    const successes = [r1, r2].filter((r) => r.success);
    expect(successes).toHaveLength(1);
  });
});

describe("parsePairingLink", () => {
  it("parses a valid pairing link", async () => {
    const manager = new PairingManager();
    const { link } = await manager.generatePairingLink("https://tunnel.example.com");

    const parsed = await parsePairingLink(link);
    expect(parsed.publicKey).toEqual(manager.getKeypair()!.publicKey);
    expect(parsed.fingerprint.length).toBe(16);
    expect(parsed.version).toBe(1);
  });

  it("throws on missing parameters", async () => {
    await expect(parsePairingLink("https://tunnel.example.com/pair?pk=abc")).rejects.toThrow(
      "missing required parameters",
    );
  });
});
