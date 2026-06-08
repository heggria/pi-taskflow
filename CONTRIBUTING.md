# Contributing to pi-taskflow

Thanks for your interest. `pi-taskflow` is a fast-moving project maintained primarily by [@heggria](https://github.com/heggria). Contributions are welcome — here's how.

## Quick start

```bash
git clone git@github.com:heggria/pi-taskflow.git
cd pi-taskflow
npm install
npm run typecheck   # TypeScript checks
npm test            # 394 tests, all passing
```

> `npm run test:e2e` runs real end-to-end tests that spawn live Pi subagents. It needs `pi` installed and model access configured. CI runs unit tests only.

## What makes a good contribution

- **New phase types** — the DSL is the heart of the project. See `schema.ts` for the phase type registry.
- **Example flows** — copy one from `examples/`, adapt it, and send a PR. Each example should demonstrate a distinct pattern (fan-out, gating, approval, loop, tournament…).
- **Docs & TUI polish** — live progress, error messages, and diagnostic output are always improving.
- **Cache / store improvements** — the atomic file lock and cross-run memoization store are zero-dependency. All improvements must stay dependency-free or become optional peerDeps.

## Before you open a PR

1. **Open an issue first** to discuss the change. PRs without a linked issue may sit un-reviewed.
2. Keep the diff focused — one concern per PR.
3. All existing tests must pass (`npm test`).
4. Add tests for new behavior (the test suite is in `test/`).
5. Format is whatever Prettier with default settings would do. No strict config enforced.

## Response time

I review issues and PRs ~weekly. If you need a faster turnaround, mention why in the issue and I'll try to prioritize.

## Architecture

See [`DESIGN.md`](./DESIGN.md) for the full design rationale. Quick orientation:

| Directory | What |
|-----------|------|
| `extensions/` | Runtime, schema, agents, store, cache, init, render, verify |
| `extensions/agents/` | 18 built-in agent definitions (`.md` with YAML frontmatter) |
| `test/` | 394 unit tests across 18 suites |
| `examples/` | Runnable flow definitions (`.json`) |
| `skills/` | Pi skill definitions for model prompting |
| `docs/` | Design docs, RFCs, dogfooding reports |

## License

MIT. By contributing you agree your contribution will be licensed under the same terms.
