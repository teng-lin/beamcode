# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
pnpm build           # full build (lib + web)
pnpm build:lib       # TypeScript library only (tsdown + fix-dts)
pnpm build:web       # React frontend only

# Type / lint / format
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome lint src/
pnpm check:fix       # biome check --write src/ (auto-fix)
pnpm check:arch      # enforce architectural layer boundaries

# Unit tests
pnpm test                           # vitest run (all unit tests)
pnpm test:watch                     # vitest watch mode
pnpm exec vitest run -t "test name" # run single test by name

# E2E mock (mock CLI — fast, no real credentials needed)
pnpm test:e2e                       # alias for test:e2e:mock
pnpm test:e2e:mock
pnpm exec vitest run --config vitest.e2e.config.ts -t "test name"

# E2E real backends 
pnpm test:e2e:real:smoke            # smoke tier, all adapters
pnpm test:e2e:real:full             # full tier, all adapters
pnpm test:e2e:real:claude           # Claude-only full
pnpm test:e2e:real:codex            # Codex-only full
pnpm test:e2e:real:gemini           # Gemini-only full
pnpm test:e2e:real:opencode         # OpenCode-only full
pnpm test:e2e:real:agent-sdk        # Agent SDK full

# Run a single real e2e test with full tracing
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  E2E_PROFILE=real-full USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/real/session-coordinator-codex.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "test name" 2>trace.ndjson
pnpm trace:inspect   # interactive viewer for trace.ndjson
```

