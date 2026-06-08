# Changelog

All notable changes to pi-taskflow are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

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
