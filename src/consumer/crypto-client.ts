/**
 * Stub crypto client for future end-to-end encryption via libsodium.
 * Currently passes data through unencrypted.
 */
export class CryptoClient {
  private _paired = false;

  async initFromPairingLink(_params: URLSearchParams): Promise<void> {
    // Will extract keys from pairing link and initialize libsodium
    this._paired = false;
  }

  async encrypt(message: Uint8Array): Promise<Uint8Array> {
    return message;
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    return ciphertext;
  }

  isPaired(): boolean {
    return this._paired;
  }
}
