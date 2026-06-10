# SKILL Coverage Audit — pi-taskflow

> **Date:** 2026-06-10
> **Status:** Authoritative (v2, revised after multi-agent cross-adversarial review). Machine-checked against `extensions/schema.ts` + human-validated (coincidental-word false positives excluded).
> **Reviewed by:** multi-agent cross-adversarial review (risk-reviewer ~96% accuracy / reviewer / critic). Corrections folded into this revision (see §9).
> **Remediation:** ✅ **DONE** (§8 plan executed in SKILL.md, +87 lines). Phase-type table now lists 9 types; `### Loop phases` and `### Tournament phases` sections added; `eval` + `onBlock` folded into the Gate section; `cache` pointer + `optional` + static `branches` added in Configuration/routing. All 4 embedded JSON examples validate against the real schema; 560/560 tests pass; typecheck clean.

## 1. Purpose

`skills/taskflow/SKILL.md` is **the primary authoring guide the LLM reads** when writing a taskflow. The LLM *also* sees the `taskflow` tool description, which already lists all 9 phase types by name (`extensions/index.ts:324`). So the gap is **not** "the feature does not exist for the LLM" — it is that **the configuration surface (field names, examples) is undocumented**, so the LLM knows a phase type *exists* but cannot reliably author it correctly.

This audit maps the **schema** (the authoritative set of fields/phase-types an LLM can use) against **SKILL.md** to find features that are **implemented + tested in code but un-authorable** because SKILL.md omits their field surface and examples.

## 2. Method

- **Truth source:** `extensions/schema.ts` (`PhaseSchema`, `TaskflowSchema`, `PHASE_TYPES`, and the supporting `RetrySchema`/`CacheSchema`/`BudgetSchema`). Every `Type.Optional(...)` key is a field the LLM can emit.
- **Coverage probe:** a field counts as **documented** only when it appears in SKILL.md as a real taskflow field — i.e. wrapped in backticks (`` `field` ``) or as a JSON key (`"field":`). Plain-English occurrences of the same word (e.g. the English word "context", "optional" used as an adjective) are **excluded as coincidental** and were human-verified.
- **Classification:** `PRESENT` (dedicated explanation and/or example), `THIN` (a passing mention only, no dedicated section/example), `MISSING` (no documentation at all).
- **Cross-check:** each `MISSING`/`THIN` field was confirmed to be a live, user-facing `Type.Optional` field in schema (not deprecated, not internal) at the cited line.

## 3. Headline Result

| Surface | Code reality | SKILL.md reality | Gap |
|---|---|---|---|
| Phase types | **9** (`agent, parallel, map, gate, reduce, approval, flow, loop, tournament`) | type table lists **7** (stops at `flow`) | **`loop`, `tournament` invisible** |
| User-facing fields | ~45 | 16 fully missing, 2+ thin | whole feature clusters invisible |

The omissions are not random — they cluster around **exactly the features the project markets as its competitive moat** (see §6).

## 4. Severity-Ranked Findings

### 🟠 SEV-2 (High) — Whole phase types un-authorable (configuration surface undocumented)

> **Severity recalibrated from SEV-1→SEV-2** after review: the tool description (`index.ts:324`) already names `loop` and `tournament`, so their *existence* is known to the LLM. The primary pipelines (map→gate→reduce) are fully documented and unaffected, so the system is not "broken". The real gap is that the **control fields are undocumented**, so the LLM cannot author these phases correctly.

| Phase type | Implemented | Tested | SKILL phase-type table (lines 84–90) | Dedicated section | Verdict |
|---|---|---|---|---|---|
| `loop` | ✅ runtime.ts | ✅ `test/loop.test.ts` | ❌ not in table | ⚠️ 4 occurrences, but only a passing hint (~line 174, flow{def} section); no control fields, no example | **un-authorable** |
| `tournament` | ✅ runtime.ts | ✅ `test/tournament.test.ts` | ❌ not in table | ❌ **zero mentions** | **un-authorable** |

**Evidence:** the SKILL.md phase-type table ends at `` | `flow` | run a sub-flow … | `` (line 90). An LLM reading the table concludes pi-taskflow has 7 authoring-documented phase types. Even though the tool description names `loop`/`tournament`, without table rows, control-field docs, or examples the LLM cannot reliably emit a correct `type: "loop"` / `type: "tournament"` phase.

### 🟠 SEV-2 (High) — Feature clusters invisible across ALL LLM channels

| Cluster | Missing fields (schema line) | Effect of omission |
|---|---|---|
| **Cross-run caching** | `cache` (241) and its sub-properties `scope` (78), `ttl` (85), `fingerprint` (91) | LLM never enables memoization — the feature COMPETITORS.md calls "nobody else owns it". **Strongest finding: invisible in SKILL.md, configuration.md, AND the tool description.** |
| **Loop control** | `until` (148), `maxIterations` (154), `convergence` (160) | `loop`'s control surface is undocumented — the LLM knows the type exists but not how to configure it |
| **Tournament control** | `variants` (169), `judge` (175), `mode` (184); `judgeAgent` (181) is a rarely-needed override | `tournament`'s control surface is undocumented |

> Note: `scope`/`ttl`/`fingerprint` are sub-properties of the `cache` object, not independent top-level fields — counted under the single `cache` cluster, not as 3 separate gaps (corrected after review).

### 🟡 SEV-3 (Medium) — Advanced gate features (basic gate works without them)

| Cluster | Missing fields (schema line) | Effect of omission |
|---|---|---|
| **Eval gate + self-heal** | `eval` (235), `onBlock` (228) | LLM never writes zero-token machine gates or self-healing rework loops. Basic `gate` (VERDICT: PASS/BLOCK) is fully documented and works without these. |
| **Context control** | `context` (216), `contextLimit` (222) | niche power-user optimization knobs; flows are correct without them. **Belongs in configuration.md, not SKILL.md.** |

### 🟢 SEV-4 (Low) — Thin coverage (mentioned, but no dedicated explanation/example)

| Field (schema line) | Current SKILL presence | Gap |
|---|---|---|
| `branches` (126) | only in the type table + a routing heading | no example of static parallel branches |
| `optional` (212) | only as `optional: true` inside the flow{def} section | no general explanation of fail-soft phases |

### ⚫ NOT A GAP — deliberately excluded after review

| Field (schema line) | Why it should NOT be documented in SKILL.md |
|---|---|
| `version` (259) | **Dead field** — the runtime never reads it (`grep '\.version' extensions/*.ts` is empty); configuration.md already notes "declared but not yet used". Documenting it would teach the LLM to emit a no-op field. |

## 5. Full Coverage Matrix

| Field | schema line | Belongs to | SKILL status |
|---|---|---|---|
| type | 115 | all | PRESENT |
| agent | 116 | all | PRESENT |
| task | 117 | agent/gate/reduce/map | PRESENT |
| over | 120 | map | PRESENT |
| as | 123 | map | PRESENT |
| branches | 126 | parallel | **THIN** |
| from | 129 | reduce | PRESENT |
| use | 134 | flow | PRESENT |
| def | 135 | flow | PRESENT |
| with | 141 | flow | PRESENT |
| until | 148 | loop | **MISSING** |
| maxIterations | 154 | loop | **MISSING** |
| convergence | 160 | loop | **MISSING** |
| variants | 169 | tournament | **MISSING** |
| judge | 175 | tournament | **MISSING** |
| judgeAgent | 181 | tournament | **MISSING** |
| mode | 184 | tournament | **MISSING** |
| dependsOn | 192 | all | PRESENT |
| join | 193 | all | PRESENT |
| when | 199 | all | PRESENT |
| retry | 205 | all | PRESENT |
| output | 206 | all | PRESENT |
| model | 207 | all | PRESENT |
| thinking | 208 | all | PRESENT |
| tools | 209 | all | PRESENT |
| cwd | 210 | all | PRESENT |
| final | 211 | all | PRESENT |
| optional | 212 | all | **THIN** |
| concurrency | 215 | map/parallel | PRESENT |
| context | 216 | all | **MISSING** |
| contextLimit | 222 | all | **MISSING** |
| onBlock | 228 | gate | **MISSING** |
| eval | 235 | gate | **MISSING** |
| cache | 241 | all | **MISSING** |
| scope | 78 | cache | **MISSING** |
| ttl | 85 | cache | **MISSING** |
| fingerprint | 91 | cache | **MISSING** |
| backoffMs | 63 | retry | PRESENT |
| factor | 64 | retry | PRESENT |
| budget | 262 | flow-level | PRESENT |
| maxUSD | 104 | budget | PRESENT |
| maxTokens | 105 | budget | PRESENT |
| args | 260 | flow-level | PRESENT |
| agentScope | 263 | flow-level | PRESENT |
| strictInterpolation | 266 | flow-level | PRESENT |
| version | 259 | flow-level | **DEAD FIELD** (runtime never reads it; correctly omitted) |
| name | 257 | flow-level | PRESENT |

**Tally (revised after review):** of the originally-flagged 16 MISSING — 11 genuinely belong in SKILL.md (loop+tournament phase types and their control fields, eval/onBlock); `cache` + 3 sub-properties are 1 cluster (brief SKILL mention + configuration.md detail); `context`/`contextLimit` belong in configuration.md only; `version` is a dead field to be left undocumented. 2 THIN (`branches`, `optional`). ~26 PRESENT.

## 6. Strategic Irony

The project's own positioning documents present three features as the competitive wedge that surpasses LangGraph / Temporal / Claude Code:

- `STRATEGY.md` / `COMPETITORS.md`: **cross-run memoization** — *"Nobody owns cross-run memoization — pi-taskflow shipped it."*
- `STRATEGY.md`: **`loop` with convergence detection** and **`tournament`** listed as shipped capability-gap closers.

**All three are undocumented in SKILL.md.** The flagship moat features are written into the engine but omitted from the one manual the LLM reads — so in practice the LLM never reaches for them. The marketing claim and the LLM-reachable surface are out of sync.

## 7. Root Cause & Process Fix

**Root cause:** features were shipped with synchronized **schema + runtime + tests**, but **SKILL.md (the LLM's only manual) was not updated in lockstep**. The test suite proves the code works; it does not prove the LLM can discover the feature. SKILL.md omission = the feature does not exist for the LLM.

**Process fix — Definition of Done for any new field/phase type:**

A change that adds a user-facing `Type.Optional` field or a `PHASE_TYPES` entry is **not complete** until:
1. ☐ schema + runtime + validation + tests (already enforced)
2. ☐ **SKILL.md phase-type table updated** (for new phase types)
3. ☐ **SKILL.md gains a dedicated section** explaining the field/phase
4. ☐ **A minimal JSON example** is added (in the section and/or `examples/`)
5. ☐ A coverage check (`grep` for the field as a backtick/JSON-key in SKILL.md) passes

> Recommend adding step 5 as a lightweight CI grep so a new schema field with zero SKILL.md mentions fails the build.

## 8. Remediation Plan (revised scope, ~67 lines / ~4% growth)

> Scope tightened after review to avoid bloating SKILL.md (~16KB) and diluting the high-signal 80%-case content. Documentation only — zero code, zero regression.

**DO (in SKILL.md):**
1. **Phase-type table** — add two rows after `flow`:
   - `` | `loop` | repeat a body until a condition / convergence / maxIterations | ``
   - `` | `tournament` | run N competing variants, a judge picks best / aggregates | ``
2. **`### Loop phases`** section — `until`, `maxIterations`, `convergence`, with one minimal JSON example (cite `examples/iterative-replan.json`).
3. **`### Tournament phases`** section — `variants`, `judge`, `mode` (mention `judgeAgent` as a parenthetical override), with one minimal JSON example.
4. **Fold `eval` + `onBlock` into the EXISTING `### Gate phases` section** — one paragraph + one inline example. Do **not** create a standalone section for 2 gate-only fields.
5. **Brief `cache` pointer** in the Configuration section — ~3 lines ("set `cache: { scope: \"cross-run\" }` to memoize across runs; see configuration.md for `ttl`/`fingerprint`/scope"). Detailed mechanics live in configuration.md.
6. **Fold in THIN fields** — add a static `branches` example to the routing section; give `optional` a one-line general explanation.
7. **Validate** — confirm every `examples/*.json` still passes `validateTaskflow()` after edits.

**DO (in configuration.md, not SKILL.md):**
8. Document `context` / `contextLimit` (niche optimization knobs) and the full `cache`/`scope`/`ttl`/`fingerprint` mechanics.

**DO NOT (cut after review as over-scope / YAGNI):**
- ❌ A standalone "Eval gates & self-healing" section (fold into Gate section instead).
- ❌ A standalone "Cross-run caching" section in SKILL.md (brief pointer only; detail in configuration.md).
- ❌ Documenting `version` anywhere (dead field).
- ❌ Documenting `context`/`contextLimit` in SKILL.md (configuration.md only).
- ❌ The CI grep check from §7 (brittle, low-signal, false-positives on dead/internal fields). Replace with: new fields must ship with an `examples/*.json` demonstrating them.

## 9. Corrections folded in from cross-adversarial review

| # | Reviewer | Correction | Applied |
|---|---|---|---|
| 1 | critic | Thesis "feature does not exist for the LLM" was overstated — the tool description (`index.ts:324`) names all 9 phase types. Reframed as "un-authorable (config surface undocumented)". | §1, §4 |
| 2 | critic / risk | `loop`/`tournament` severity inflated. Recalibrated SEV-1→SEV-2; eval/onBlock→SEV-3. | §4 |
| 3 | risk | `loop` mention count wrong ("1"→actually 4). Corrected. | §4 |
| 4 | reviewer | `version` is a dead field (runtime never reads it). Moved from "document it" to "deliberately exclude". | §4, §5, §8 |
| 5 | reviewer | `scope`/`ttl`/`fingerprint` are `cache` sub-properties, not 3 independent gaps. De-inflated the count. | §4, §5 |
| 6 | reviewer | `context`/`contextLimit` are niche — configuration.md, not SKILL.md. | §4, §8 |
| 7 | reviewer / critic | Remediation over-scoped (4 sections + CI grep). Trimmed to 2 sections + fold-ins + pointers; dropped CI grep. | §8 |

---
*Every cited schema line was read directly. No counts are estimated. PRESENT classifications are conservative (a field is only PRESENT if it has real documentation, not a coincidental word match).*
