# Devil's Advocate Report: Architecture Decisions

**Purpose**: Construct the strongest possible argument AGAINST each decision. Not trying to be helpful — trying to find the fatal flaw.

---

## Decision 1: Library First, Relay-Aware

### The Counter-Argument: Build the Relay First

The Oracle's case was explicit: relay is the **core differentiator**. SSH+tmux already solves "use a CLI agent from a different terminal." The ONLY thing this project offers that doesn't exist is **mobile access to running agent sessions**. By choosing "library first," you're building the thing that has the LEAST competitive advantage first, and deferring the thing that ACTUALLY matters.

"Relay-aware design" is a comforting fiction. You CANNOT design for a distributed system you haven't built. Every team that's tried "design the interfaces now, implement later" discovers that the interfaces are wrong once they hit reality. The serialization assumptions, the reconnection semantics, the encryption boundaries — you'll get them wrong because you haven't felt the pain of implementing them.

Momus himself says daemon/relay has a **10% probability of ever shipping**. By deferring it, you're not "being pragmatic" — you're burying your core value proposition. If relay never ships, this is just another adapter library in a market that doesn't need one.

### The Catastrophe Scenario

12-14 weeks later, you ship the library. It works. Nobody cares. The library is used by... you. Maybe 2-3 hobbyists. Meanwhile, competitors ship mobile access (Cursor already has remote sessions, Windsurf has cloud IDE). By the time you circle back to relay (if ever), the market has moved on. The "relay-aware interfaces" you designed don't match reality, requiring a significant rewrite of the core types you spent 3 months building.

### The Reversal Cost

**HIGH**. If you later decide relay should have been first, you've spent 12-14 weeks building adapter abstractions optimized for local in-process usage. SessionBridge's in-memory state model (which Metis flagged in F6) bakes in assumptions that break for daemon scenarios. Reversal means gutting the state layer you just built.

### Reversal Likelihood: **40%**

The relay will either never ship (confirming the decision by default) or when attempted, will force significant rearchitecting of the "relay-aware" interfaces. Either way, the "relay-aware" design investment is partially wasted.

---

## Decision 2: Adapter Priority — SdkUrl + ACP + AgentSDK

### The Counter-Argument: Build AgentSDK First, Drop ACP

This is the most dangerous decision. You're building your **primary adapter** on `--sdk-url`, which is **unofficial, undocumented, and could be removed at any time** (Momus: HIGH fragility risk, Metis: A5). You're betting the entire project on a flag that Anthropic never promised to maintain.

The AgentSDK is the **official** Anthropic API. It's stable. It's documented. It's the thing Anthropic WANTS you to use. By making it the "fallback/insurance" instead of the primary, you're optimizing for today's convenience over tomorrow's survival.

ACP is a **draft spec** (Momus: MEDIUM risk, rapidly evolving). You're betting 3 weeks of engineering on a protocol that could change fundamentally. The "25+ agents" claim is already debunked to 5-6 (Momus), and several of those (Gemini CLI, Kiro) have their own unstable APIs. ACP's capability model is incomplete for your use case — no modelSwitching, no sessionFork, no costTracking. You'll need agent-specific shims anyway, defeating the "universal adapter" purpose.

The safer bet: AgentSDK (official, stable) as primary, SdkUrl as secondary for power users, skip ACP entirely until the spec stabilizes (post-1.0).

### The Catastrophe Scenario

Claude Code 2.0 ships in 6 months. `--sdk-url` is removed or its protocol changes dramatically (it's undocumented, so there's no semver contract). Your primary adapter breaks overnight. ACP goes through a breaking revision. Two of your three adapters are broken simultaneously. Only AgentSdkAdapter (the one you deprioritized) still works, but it was built as an afterthought and can't handle all features.

### The Reversal Cost

**VERY HIGH**. If SdkUrl breaks, you need to emergency-migrate to AgentSDK as primary. But the AgentSdkAdapter was built with "50% success probability" (Momus) and as a secondary concern. The permission bridging (Promise-to-Message pattern) wasn't battle-tested because SdkUrl was doing the heavy lifting. You now need to solve all the hard problems (async coordination, race conditions — Metis A1, Protocol #3) under emergency pressure.

### Reversal Likelihood: **55%**

`--sdk-url` is undocumented. The probability it survives unchanged for 12 months is LOW. Either it changes (breaking your adapter) or gets replaced by official APIs (making your adapter obsolete). Either way, you'll be rewriting the primary adapter.

---

## Decision 3: PTY Strategy — Composable Utility

### The Counter-Argument: Build a Standalone PTY Adapter

The composable utility sounds elegant, but it creates an **invisible dependency**. Adapters that "optionally" use PTY will have untested code paths. When ACP doesn't support slash commands, the PTY sidecar kicks in — but this hybrid path is the one LEAST tested and MOST fragile.

A standalone PTY adapter has one massive advantage: it works with **every** CLI agent, including ones that don't support ACP, don't have an SDK, and will never get a structured API. Aider, Trae, Amp — none of these have programmatic interfaces. A PTY adapter is the ONLY path to true universality. By relegating PTY to a "utility," you're implicitly saying "we only support agents with structured APIs" — which defeats the "universal" claim.

Momus says PTY "breaks every time CLI updates output format." True. But ACP also breaks when the spec evolves. Agent SDK also breaks when Anthropic changes it. The difference is: with PTY, YOU control the parser. With SDK/ACP, you're at the mercy of upstream.

### The Catastrophe Scenario

ACP adapter ships. Goose supports slash commands, Kiro doesn't, Gemini CLI doesn't. PTY sidecar kicks in for Kiro and Gemini. But the PTY bridge was "composable utility" quality — tested in isolation, never tested under the specific load patterns of Kiro's output format. ANSI parser breaks on Kiro's custom progress bars. Slash commands silently fail. Users report "slash commands don't work with Kiro" — but the feature "works" in the capability matrix. Debugging nightmare.

### The Reversal Cost

**LOW**. The document correctly notes a standalone adapter can be trivially built by composing PTY utilities. This is the least risky decision to reverse.

### Reversal Likelihood: **30%**

Likely stays as-is because standalone PTY is low priority. But the "composable utility" will need significant hardening when it's actually used by multiple adapters with different output formats.

---

## Decision 4: Mobile Readiness — Protocol-Ready, Not Implemented

### The Counter-Argument: Don't Add Protocol Types You Can't Test

Adding `message_id`, `seq`, and `timestamp` to all ConsumerMessage types is NOT "near-zero effort." It's near-zero IMPLEMENTATION effort — but it's **nonzero design effort with unknowable future costs**.

You're designing a reconnection protocol without ever having built one. The `reconnect` and `request_history` message types are **pure speculation**. When you actually implement reconnection, you'll discover:

- `last_seen_seq` isn't sufficient — you need per-stream sequence numbers if multiple backends are active
- `message_history_page` pagination doesn't account for messages that arrived during the reconnection handshake
- `seq` needs to be monotonic per-session, but what happens when sessions are forked?
- The `timestamp` field needs to be server-authoritative, but what about clock skew in relay scenarios?

Every speculative type you add is a **commitment**. Future implementers will see these types and assume they're correct. If they're wrong (likely), you've created a worse situation than having no types at all — you've created types that actively mislead.

The Mobile Expert gave a C- grade. That grade wasn't because types were missing — it was because the **implementation** was missing. Adding types without implementation is cargo-culting.

### The Catastrophe Scenario

Mobile developer joins the team in 6 months. Sees reconnection types already defined. Builds mobile reconnection against them. Discovers `last_seen_seq` doesn't work because relay adds its own sequence numbers. Now faces: (a) rewrite mobile reconnection, or (b) introduce a SECOND sequence numbering system. Both are worse than starting from scratch.

### The Reversal Cost

**LOW-MEDIUM**. Removing unused type fields is a minor breaking change for any consumers that import the types. But if any downstream code has been built against these speculative types, reversal requires coordinated migration.

### Reversal Likelihood: **60%**

The specific reconnection types are almost certainly wrong. `message_id` and `seq` on ConsumerMessage will likely survive in some form, but the `reconnect` and `request_history` message definitions will be rewritten when actual reconnection is implemented.

---

## Decision 5: Security — Quick Wins + Relay-Ready Interfaces

### The Counter-Argument: Do Nothing on Security Until Relay

WebSocket origin validation and CLI auth tokens solve a problem that **doesn't exist in practice**. The bridge runs on localhost. The threat model requires a **malicious process already running on the user's machine**. If an attacker has code execution on the user's machine, they can already:

- Read `~/.claude/` directly
- Attach a debugger to the bridge process
- Intercept any localhost traffic
- Read the auth token from the environment variable

CLI auth tokens create a **false sense of security**. They add implementation complexity (token generation, storage, rotation, error handling for wrong tokens) while stopping exactly zero realistic attacks. The Security Expert's T8 (WebSocket CSRF) is real but extremely niche — it requires the user to visit a malicious website AND have the bridge running AND the attacker to guess the session ID.

The "relay-ready auth interfaces" (Authenticator with JWT/TLS) are even more speculative. You're designing auth for a relay that doesn't exist, based on security requirements you haven't validated.

Two weeks of engineering on security for a localhost-only library is two weeks NOT spent on features that actually differentiate the product.

### The Catastrophe Scenario

You spend 2 weeks on WebSocket origin validation and CLI auth tokens. A real security researcher finds an actual vulnerability — the auth tokens are stored in an environment variable that's visible via `/proc/{pid}/environ` on Linux. Now you need to redesign the token storage. The origin validation breaks a legitimate consumer use case (Electron app with custom origin). The 2 weeks bought you negative value.

### The Reversal Cost

**LOW**. Security features can be removed or replaced without architectural impact. The auth interfaces are just interfaces — unused code with no behavior.

### Reversal Likelihood: **25%**

The origin validation and auth tokens will likely stay, but in retrospect the 2-week investment may have been better spent elsewhere. The relay-ready interfaces will definitely be rewritten when relay is actually built.

---

## Decision 6: Packaging — Single Package Now, Split Later

### The Counter-Argument: Start with Scoped Packages from Day One

"YAGNI" is the most abused principle in software engineering. The decision to stay as a monolith CREATES technical debt that accumulates silently. Every new adapter added to the single package:

- Increases install size for users who only need one adapter
- Adds all adapter dependencies to the dependency tree (ACP SDK, Agent SDK, etc.)
- Makes it impossible for tree-shaking to eliminate unused adapters (side effects, dynamic imports)
- Creates a release coupling problem: a bug fix in ACPAdapter forces a version bump that affects SdkUrlAdapter users

The RFC estimates ~12k LOC. After 3 adapters, security work, and protocol types, this will be 20-25k LOC. That's NOT small. npm packages regularly split at 5-10k LOC for good reason.

Turborepo and Nx have gotten dramatically easier. A basic monorepo with 3-4 packages takes 2-3 days to set up, not weeks. The cost of splitting later is ALWAYS higher than starting split, because you need to:
1. Untangle import cycles that accumulated during monolith phase
2. Coordinate a breaking change for all existing consumers
3. Set up scoped package publishing for the first time (npm org, auth, CI)

### The Catastrophe Scenario

6 months later, you have 3 adapters and 500+ consumers using `claude-code-bridge`. You need to split packages because community adapters want to depend on `@claude-code-bridge/core` without pulling in all of Claude Code's adapter dependencies. The split requires:
1. A major version bump (breaking change for ALL users)
2. Rewriting every import path in consumer code
3. Setting up the monorepo tooling you avoided
4. A deprecation/migration period for the old package name

This is a 2-4 week project that disrupts all users — versus the 2-3 days it would have taken to start split.

### The Reversal Cost

**MEDIUM-HIGH**. Package splitting is a breaking change that affects every consumer. The longer you wait, the more consumers you have, the more painful the split. npm package names are permanent — `claude-code-bridge` becomes a "legacy" package that needs maintenance forever.

### Reversal Likelihood: **70%**

If the project succeeds (gets users, gets community adapters), the split is inevitable. The only scenario where it doesn't happen is if the project fails and nobody uses it.

---

## Overall Assessment

### Most Dangerous Decision: **Decision 2 (Adapter Priority)**

Building the primary adapter on an unofficial, undocumented API flag (`--sdk-url`) is the single highest-risk choice. It has:
- **Highest probability of external disruption** (Anthropic can remove it any time)
- **Highest reversal cost** (emergency migration under pressure)
- **Least control** (you can't even file a bug report against an undocumented feature)
- **Compounding effect** — if SdkUrl breaks, the ENTIRE project is blocked because it's the foundation adapter

The Oracle gives the abstraction layer 9/10, but that grade is meaningless if your primary backend connection disappears. This is a "build the penthouse before checking the foundation" situation.

### Safest Decision: **Decision 3 (PTY as Composable Utility)**

This decision has:
- **Lowest reversal cost** (standalone adapter trivially built from utilities)
- **Correct assessment of risk** (PTY fragility is real)
- **No external dependencies** (doesn't rely on any spec or API to remain stable)
- **Minimal wasted investment** regardless of outcome

Even if you're wrong and PTY should be standalone, the composable utilities are still useful. This is the one decision where being wrong costs almost nothing.

---

## Risk Summary Table

| Decision | Reversal Likelihood | Reversal Cost | Danger Rating |
|----------|-------------------|---------------|---------------|
| 1. Library First | 40% | HIGH | MEDIUM-HIGH |
| 2. SdkUrl Primary | 55% | VERY HIGH | **CRITICAL** |
| 3. PTY Composable | 30% | LOW | LOW |
| 4. Protocol Types | 60% | LOW-MEDIUM | MEDIUM |
| 5. Security Quick Wins | 25% | LOW | LOW |
| 6. Single Package | 70% | MEDIUM-HIGH | MEDIUM |

**Bottom line**: Decision 2 is the one that keeps me up at night. Building your house on `--sdk-url` is building your house on someone else's undocumented internal implementation detail. Everything else is reversible at reasonable cost. That one isn't.
