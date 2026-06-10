# Changelog

All notable changes to pi-taskflow are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.0.21] — 2026-06-10

### Added
- **Per-step context pre-read in shorthand modes.** Single, chain, and tasks shorthand steps now accept `context` (file paths) and `contextLimit`, desugared directly onto the generated phases. This eliminates `O(N²)` file exploration without writing the full DSL. In parallel `tasks` mode all branches share the deduped union of step contexts; chain steps each carry their own context. A top-level `context` in chain mode produces a warning (no unsupported flow-level default). Context-file changes automatically invalidate phase caches.

### Fixed
- **Headless approval safety.** Approval phases now auto-reject (not auto-approve) when running in detached/background/CI mode, preventing silent bypass of human gates.
- **Step-reference validator accepts transitive ancestors.** The step-reference checker previously raised false positives on valid DAGs where dependencies span multiple levels of ancestry. Ancestor transitive closure is now fully resolved.

## [0.0.20] — 2026-06-10

### Added
- **Background (detached) execution — `detach: true`.** Run a taskflow in a detached child process without blocking the current session. Pass `detach: true` and get a `runId` back immediately; the flow executes in the background, persisting state to the store. Status polled via `/tf runs` and `resume` works as normal.
  - `extensions/detached-runner.ts` (new): lightweight child-process entry script — reads serialized context, calls `executeTaskflow`, persists terminal state.
  - `extensions/index.ts`: `detach: Boolean` parameter on the taskflow tool + child-process spawn logic (records PID in `RunState`).
  - `extensions/store.ts`: `RunState` gains `pid?: number` + `detached?: boolean` fields; `isProcessAlive(pid)` stale-PID helper.
  - Design: entry-point spawn wrapper — zero changes to the 1340-line `runtime.ts` core, no new phase type, no DSL version bump, fully backward-compatible.
  - Approval phases auto-reject in background mode. Idle watchdog kills stalled children. Stale PID detection via signal-0 probe.
  - 8 new tests (`test/detached.test.ts`): process-alive, PID persistence, end-to-end detached, crash→failed, resume after failure, stale PID, backward compat.

### Fixed
- `approvalView` initialization robustness: throws a clear error when the approval view module is unavailable, preventing silent failures in detached/background mode.

## [0.0.19] — 2026-06-10

### Documentation
- **Closed the SKILL coverage gap — the LLM can now author every shipped feature.** A schema-vs-SKILL.md audit (`docs/internal/skill-coverage-audit.md`, machine-checked + cross-adversarial reviewed) found several implemented + tested features that were undocumented in the LLM-facing skill, so the model never generated them. All ~46 user-facing schema fields are now documented across SKILL.md + configuration.md.
  - **SKILL.md**: phase-type table now lists all 9 types (added `loop`, `tournament`) with a “details” column pointing each to its section; new **Loop phases** (`until`/`maxIterations`/`convergence`) and **Tournament phases** (`variants`/`judge`/`mode`/`judgeAgent`) sections; `eval` (zero-token machine gate) and `onBlock: "retry"` (self-healing rework loop) folded into the Gate section; cross-run `cache` pointer + `optional` + static `branches` notes.
  - **SKILL.md**: new **Operating a run** section — run lifecycle (`running → completed/blocked/failed/paused`), cache-aware resume, when to resume vs. re-run, budget-mid-run behavior, and run inspection. Clarified action semantics (`define` vs `name`, save scope/collision, `verify`/`agents` actions).
  - **configuration.md**: new **§2.1 Context pre-reading** (`context`/`contextLimit` — resolution order, per-file 8000-char cap, 200k total cap) and **§8 Cross-run caching** (`cache.scope`, `ttl`, full `fingerprint` prefix table for git/glob/glob!/file/env). Fixed a stale “5 phase types” → 9 cross-file drift.
- Every documented JSON example validates against the live schema; all run-status/resume claims verified against the runtime (`blocked` is terminal; `paused`/`failed` are resumable). 560 tests pass, zero regression.

### CI
- GitHub Packages publish is now best-effort (`continue-on-error`) so an unscoped-package 404 there can never block the npm publish or the GitHub Release.

## [0.0.18] — 2026-06-09

### Added
- **Runtime dynamic sub-flows — `flow { def }`.** A `flow` phase may now carry an inline `def` (mutually exclusive with `use`) that is resolved at runtime — typically from an upstream phase's JSON output (`"def": "{steps.plan.json}"`) — validated, verified, and executed as a nested sub-flow. This is the declarative answer to code-mode `for`/`if`: a planner decides *at runtime* what work to spawn, and every generated plan is structurally checked (cycles / dangling refs / duplicate ids / dead-ends) before it spends a token.
  - Accepts a full Taskflow `{name,phases}`, a bare `phases` array, or `{phases:[...]}` (markdown ```json fences tolerated). Pure data — no `eval`.
  - **Iterative replanning**: pair with `loop` so round N's plan depends on round N-1's *result* (not a one-shot fan-out).
  - **Fail-open**: a malformed/invalid/unverifiable def never aborts the run — the phase resolves as a no-op with a `defError` diagnostic and upstream output is preserved. An empty `phases` array is a valid no-op.
  - New examples: `examples/dynamic-plan-execute.json`, `examples/iterative-replan.json`.

### Security
- **Hardening for runtime-generated (untrusted) sub-flows**, enforced only when content is LLM-authored:
  - Breadth caps: `MAX_DYNAMIC_PHASES` (100), `MAX_DYNAMIC_CONCURRENCY` (16, flow- and phase-level), `MAX_DYNAMIC_MAP_ITEMS` (200, fan-out truncated not blocked).
  - `cwd` containment: a generated phase cannot escape the run directory.
  - Budget clamp: a generated def's budget is clamped to `min(child, parent)` per dimension — it can only ever be tighter, never looser.
  - Nesting cap: `MAX_DYNAMIC_NESTING` (5) bounds inline self-spawning depth.
  - Prototype-pollution defense: inline defs are deep-cloned and `__proto__`/`constructor`/`prototype` own-keys are stripped.
- Authored/saved flows (`use`) are unchanged and not subject to these dynamic caps.

### Notes
- 25 new tests (`test/flow-def.test.ts`); 560 total, zero regression. Design + two-round cross-adversarial review (engineering-risk / design-critic / architecture / security) recorded under `docs/internal/`.

## [0.0.17] — 2026-06-09

### Fixed
- **28 fixes from 3-round adversarial dogfooding across 11 files.**
- **store.ts**: validateRunId path-traversal guard in saveRun, cleanupTerminalRuns race condition mtime guard, saveFlow file locking (prevents concurrent write loss), saveFlow unified sanitization via safeFlowDirName, SharedArrayBuffer hoisted to module scope, empty flow name rejection, conditional .pi/ creation hint.
- **runner.ts**: signal kill detection (killedBySignal), idle timeout excluded from transient error retry, message cap (500) with truncation notice, stderr cap (64KB) with truncation notice.
- **runtime.ts**: loop abort semantics (stop: "aborted"), failed phase interpolation (sensible placeholder instead of raw template), tournament judge budget/abort guard, retry factor asymmetry documentation.
- **interpolate.ts**: tokenizer escaped quote handling (character-by-character loop), graceful dig() trailing path segment resolution.
- **index.ts**: /tf save and /tf verify tab completion, JSON string define parsing in renderCall label, escaped quote handling in parseArgsString.
- **agents.ts**: YAML tools type validation (reject non-string/array), atomic writeFileAtomic in syncBuiltinAgentsToProject.
- **cache.ts**: 30s timeout on execFileSync git calls.
- **verify.ts**: budget maxUSD overflow detection.
- **render.ts**: consistent numerator/denominator in summarizeRun.
- **runs-view.ts**: timeAgo negative timestamp guard, blocked status removed from isResumable.

## [0.0.16] — 2026-06-09

### Added
- Built-in agents configurable via `/tf init` — customize model role, thinking level, and tools per agent.
- Community PR support: `feat/configurable-builtin-agents` (thanks @yolonir).
- Multi-language READMEs: 简体中文, हिन्दी, Español, العربية, বাংলা, Português, Русский.
- `AGENTS.md` project guide — agent pipeline rules, review routing, executor selection, escalation paths.
- GitHub issue templates (bug report + feature request) and PR template.

### Changed
- Social preview OG image for npm/ GitHub card.
- Internal docs reorganized under `docs/internal/` for clean project root.
- Run cleanup made configurable with `.pi/` creation notification.
- npm tarball slimmed — only essential files shipped.

### Tests
- 10 previously uncovered critical code paths covered (runtime branches, interpolate edge cases, transient error heuristics, store concurrency).
- Total: **524 tests** (was 394).

## [0.0.15] — 2026-06-09

### Added
- Built-in agent auto-sync to project `.pi/agents/` — first-class community collaboration.
- Tool description updated: `taskflow` now replaces `subagent` as the recommended delegation API.

### Changed
- Multi-language READMEs completed with >2% native-speaker coverage (7 languages).

## [0.0.14] — 2026-06-08

### Added
- Static DAG verification (`verify.ts`) — dead-end detection, gate exhaustion, ref integrity, concurrency warnings, guard contradictions — all computed at 0 tokens before a single agent runs.
- `onBlock: "retry"` — retry upstream phases when a gate blocks, instead of halting the run.
- Declarative eval gates — machine-checkable criteria that run *before* the LLM gate.
- Budget and idle-watchdog guards on `onBlock:retry` loops + nested recursion depth cap.

## [0.0.13] — 2026-06-07

### Added
- `loop` phase — iterate a task until a condition, convergence, or cap.
- `tournament` phase — best-of-N with a judge (or aggregate mode).
- Cross-run memoization (`cache: { scope: "cross-run" }`) with git/file/glob/env fingerprints, TTL, and LRU eviction.
- Interactive `/tf init` with action menu, role-aware model pickers, diff preview, and atomic merge-write.
- 18 built-in agents with 6 model roles (`{{fast}}`, `{{strong}}`, `{{thinker}}`, `{{arbiter}}`, `{{vision}}`, `{{reasoner}}`).

### Fixed
- P0 cache-key correctness after adversarial cross-review.
- `/tf init` compile error and custom model registry validation.
- Multi-agent review must-fixes (F1 label parse, F5 missing modelRoles).

## [0.0.12] — 2026-06-05

### Added
- Model role system with `/tf init` interactive setup.
- Per-phase `model`, `thinking`, `tools` overrides.

## [0.0.11] — 2026-06-04

### Added
- Full control-flow & reliability layer: `when` guards, `join: any` OR-joins, `retry` with backoff, `approval` human-in-the-loop, `flow` sub-flow composition, `budget` caps.
- Idle watchdog (kills wedged subagents after 5 minutes of silence).
- Transient error auto-retry (rate-limit / 5xx / timeout).

### Changed
- README rewritten as flagship landing page with hero flow diagram and competitive comparison.

## [0.0.10] — 2026-06-03

### Added
- Live DAG render with timing, cost, and sub-task progress in the TUI.
- `approval` phase type (approve / reject / edit).
- Cross-session resume with per-phase input-hash caching.

## [0.0.9] — 2026-06-02

### Added
- `map` phase dynamic fan-out over JSON arrays.
- `reduce` phase aggregation.
- `gate` phase with `VERDICT: PASS / BLOCK` parsing.
- `/tf:<name>` command shortcuts for saved flows.

## [0.0.8] — 2026-06-01

### Added
- 13 dogfooding fixes + 6 meta-bug hardening.
- Run state storage: per-flow subdirectories, index, file lock, TTL cleanup.
- Agent availability query command + unknown-agent runtime degradation.

### Fixed
- Stalled subagent kill and negative-timer freeze.
- Index concurrency lock + stale-lock atomic preemption + flowName path-escape hardening.

## [0.0.7] — 2026-05-31

### Fixed
- 11 critical defects from adversarial review batch fix.

## [0.0.6] — 2026-05-30

### Added
- Structural refactor of control flow and reliability features.
- Self-audit and repair loop.

## [0.0.5] — 2026-05-29

### Added
- Shorthand modes (`task`, `tasks`, `chain`) — same shape as the built-in subagent tool.
- `/tf save`, `/tf list`, `/tf show` commands.

## [0.0.4] — 2026-05-28

### Added
- Initial DSL: `agent`, `parallel` phases.
- `{args.X}`, `{steps.ID.output}`, `{previous.output}` interpolation.
- DAG validation: cycle detection, reference soundness.

## [0.0.3] — 2026-05-27

### Added
- Inline flow execution via `taskflow` tool.
- Run state persistence for resume.

## [0.0.2] — 2026-05-26

### Added
- Extension scaffolding: tool registration, command registration, agent discovery.

## [0.0.1] — 2026-05-25

### Added
- Initial release. Declarative DAG orchestration for Pi subagents.
