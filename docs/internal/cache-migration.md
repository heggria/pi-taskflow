# Cross-run Cache Key Migration

## Background

The cross-run memoization cache (`extensions/cache.ts`) keys each phase result by
a content-addressed `inputHash` folded from the flow name, the phase identity,
the resolved task, the model/thinking/tools config, the pre-read context, and an
optional world-state fingerprint.

Before H1, the cache key folded the flow **definition** fingerprint under a bare
`flowdef:` prefix (or, in the earliest pre-flowDefHash era, omitted it entirely).
H1 versions the key with a `v2:` prefix and routes the fingerprint through the
FlowIR compile seam (`compileTaskflowToIR` → `flowDefHash`).

To avoid a one-time miss-storm on upgrade, the runtime consults **three** keys
on every cross-run lookup, read-only for the legacy tiers.

## Key shapes (H1)

`cacheKeys()` (`extensions/runtime.ts`) returns three keys for a phase:

| Tier | Shape | Written by | Status |
|------|-------|-----------|--------|
| `key` (current) | `flow:<name>` + `v2:flowdef:<hash>` + `<phase>` + `think/tools/ctx` + fingerprint | H1+ | **read + write** |
| `bareKey` | `flow:<name>` + `flowdef:<hash>` (bare, unversioned) + … | pre-H1 | **read-only** (removed in v0.1.0) |
| `legacyKey` | `flow:<name>` + … (flowdef line omitted) | pre-flowDefHash era | **read-only** (removed in v0.1.0) |

### Lookup order (`cachedPhase`)

1. within-run resume (`cc.prior.inputHash === keys.key`) — fastest, always allowed.
2. `store.get(keys.key)` — current v2 entry.
3. `store.get(keys.bareKey)` — pre-H1 bare entry.
4. `store.get(keys.legacyKey)` — pre-flowDefHash entry.

A hit on **any** tier is restored as a `cacheHit: "cross-run"` result with zero
usage. The restored `PhaseState.inputHash` is always `keys.key` (the current
shape), so downstream phases and recompute see a consistent identity.

### Write policy (`recordCache`)

Only `keys.key` (the current v2 shape) is ever written. Legacy/bare hits are
**not** write-through: re-storing under the new key would double the cache size
for no benefit. Legacy/bare entries age out naturally via the 90-day hard cap
(`DEFAULT_MAX_AGE_MS`) and the LRU cap (`DEFAULT_MAX_ENTRIES`).

## Why three tiers?

- **`v2:flowdef:` (current):** the versioned prefix lets a future genuine
  overstory compiler advance to `v3:flowIR:` with its own fallback tier,
  without disturbing v2 entries.
- **bare `flowdef:` (pre-H1):** pre-H1 code wrote this shape. Without the 3rd
  tier, every existing cross-run entry would silently miss on upgrade — a
  one-time miss-storm for opt-in cross-run users.
- **no-flowdef (pre-flowDefHash):** the very earliest cross-run entries, before
  the flow definition was folded into the key at all. Retained for completeness;
  these are rare.

## Retirement

- **v0.1.0:** remove the `bareKey` and `legacyKey` tiers and the `CacheKeys`
  return to a single `key`. By then all pre-H1 entries will have aged out (90-day
  hard cap). The `v2:` prefix is retained as the version anchor for the *next*
  migration.
- A pre-release verification step: inspect a real `.pi/taskflow/cache/` directory
  for bare-`flowdef:` entries. If cross-run is confirmed unused in production
  (opt-in, young), the bare tier can be dropped earlier.

## See also

- `extensions/flowir/hash.ts` — the vendored overstory hash algorithm.
- `extensions/flowir/index.ts` — `compileTaskflowToIR` (the seam that produces
  `hash` and `meta.declaredDeps`).
- `docs/internal/overstory-convergence-roadmap.md` §3 (M1).
- `test/cache-migration.test.ts` — the migration contract tests.
