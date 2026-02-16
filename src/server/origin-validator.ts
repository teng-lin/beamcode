export interface OriginValidatorOptions {
  /** Additional allowed origins beyond localhost. */
  allowedOrigins?: string[];
  /** Allow connections without Origin header (default: true for CLI/programmatic). */
  allowMissingOrigin?: boolean;
}

const LOCALHOST_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Validates WebSocket connection origins against an allowlist.
 * Localhost origins are always permitted. Missing origins are permitted
 * by default (for programmatic/CLI clients).
 */
export class OriginValidator {
  private readonly allowMissingOrigin: boolean;
  private readonly allowedOrigins: Set<string>;

  constructor(options?: OriginValidatorOptions) {
    this.allowMissingOrigin = options?.allowMissingOrigin ?? true;
    this.allowedOrigins = new Set((options?.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  }

  isAllowed(origin: string | undefined): boolean {
    if (origin === undefined) {
      return this.allowMissingOrigin;
    }

    if (origin === "") {
      return false;
    }

    const normalized = origin.toLowerCase();

    if (this.isLocalhostOrigin(normalized)) {
      return true;
    }

    if (this.allowedOrigins.has(normalized)) {
      return true;
    }

    return false;
  }

  private isLocalhostOrigin(origin: string): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }

    return LOCALHOST_HOSTS.includes(url.hostname);
  }
}
