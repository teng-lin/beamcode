export class BeamCodeError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BeamCodeError";
    this.code = code;
  }
}

// ── Domain errors ──

export class StorageError extends BeamCodeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "STORAGE", options);
    this.name = "StorageError";
  }
}

export class ProcessError extends BeamCodeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "PROCESS", options);
    this.name = "ProcessError";
  }
}

// ── Utilities ──

/** Coerce unknown thrown value to BeamCodeError (preserves cause chain). */
export function toBeamCodeError(value: unknown): BeamCodeError {
  if (value instanceof BeamCodeError) return value;
  if (value instanceof Error) return new BeamCodeError(value.message, "UNKNOWN", { cause: value });
  return new BeamCodeError(String(value ?? "Unknown error"), "UNKNOWN");
}

/** Extract error message string from unknown thrown value. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value == null) return "Unknown error";
  return String(value);
}
