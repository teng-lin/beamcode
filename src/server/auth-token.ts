import { randomBytes, timingSafeEqual } from "node:crypto";

export interface TokenRegistry {
  generate(sessionId: string): string;
  validate(sessionId: string, token: string): boolean;
  revoke(sessionId: string): void;
  has(sessionId: string): boolean;
}

export class InMemoryTokenRegistry implements TokenRegistry {
  private tokens = new Map<string, Buffer>();

  generate(sessionId: string): string {
    const tokenBuffer = randomBytes(32);
    this.tokens.set(sessionId, tokenBuffer);
    return tokenBuffer.toString("hex");
  }

  validate(sessionId: string, token: string): boolean {
    const stored = this.tokens.get(sessionId);
    if (!stored) return false;

    let provided: Buffer;
    try {
      provided = Buffer.from(token, "hex");
    } catch {
      return false;
    }

    // Reject empty or malformed tokens that decoded to zero length
    if (provided.length === 0 || stored.length !== provided.length) return false;

    return timingSafeEqual(stored, provided);
  }

  revoke(sessionId: string): void {
    this.tokens.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.tokens.has(sessionId);
  }
}
