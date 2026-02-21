# Consumer Protocol Versioning

## Current Version

- `CONSUMER_PROTOCOL_VERSION = 1`
- Defined in:
  - `src/types/consumer-messages.ts`
  - `shared/consumer-types.ts`

## Compatibility Rules

1. Additive fields are allowed in the same protocol version.
2. Removing or renaming fields requires a version bump.
3. `session_init` should carry `protocol_version` so clients can branch safely.
4. Frontend must tolerate unknown additive fields for forward compatibility.

## Change Process

1. Update both protocol constants in lock-step.
2. Add/adjust contract tests before transport/runtime refactor changes.
3. Update this document and release notes when bumping the version.
