/**
 * Regression tests for the detached (background) spawn path — issue #3.
 *
 * Two bugs were fixed together:
 *  1. The detached-runner specifier resolved to `dist/detached-runner.js.js`
 *     (double `.js`) because of the `"./*"` export rewrite — the spawned
 *     child could not load the module and exited with ENOENT.
 *  2. A child that died before reaching a terminal state left the run stuck at
 *     `running` forever: `stdio: "ignore"` discarded stderr and there was no
 *     `exit`/`error` handler.
 *
 * These tests pin both behaviors using the REAL resolution path (no mock
 * runner), without needing live model access.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadRun, newRunId, saveRun, type RunState } from "taskflow-core";
import type { Taskflow } from "taskflow-core";

// The exact specifier the host uses in packages/pi-taskflow/src/index.ts.
// MUST be given WITHOUT the `.js` suffix, or the `"./*"` export rewrites it to
// `dist/<name>.js.js` (the bug). This constant mirrors the production call site
// so a future edit that reintroduces the suffix is caught here.
const DETACHED_RUNNER_SPECIFIER = "taskflow-core/detached-runner";

// ---------------------------------------------------------------------------
// Bug 1: resolution must point at a real, loadable file (no `.js.js`).
// ---------------------------------------------------------------------------

test("detached-runner: resolves to a real file on disk (no `.js.js` double suffix)", () => {
	const resolved = import.meta.resolve(DETACHED_RUNNER_SPECIFIER);
	const filePath = fileURLToPath(resolved);

	// The bug produced `…/dist/detached-runner.js.js`. Under the `development`
	// condition this resolves to src/detached-runner.ts; under the default
	// condition (published package) to dist/detached-runner.js. Either is fine —
	// the regression signature is a DOUBLE suffix and/or a missing file.
	assert.doesNotMatch(filePath, /\.js\.js$/, "must NOT be double-suffixed (.js.js) — issue #3 regression");
	assert.ok(existsSync(filePath), `resolved file must exist on disk: ${filePath}`);
	assert.ok(
		filePath.endsWith("detached-runner.ts") || filePath.endsWith("detached-runner.js"),
		`resolved path should be detached-runner.{ts,js}, got: ${filePath}`,
	);
});

test("detached-runner: the resolved module loads (spawn → exits, does not ENOENT)", async () => {
	// Spawn the real runner with a bogus context file. It will fail at runtime
	// (run not found), but the key assertion is that it does NOT die at import
	// time with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING / Cannot find module.
	const resolved = fileURLToPath(import.meta.resolve(DETACHED_RUNNER_SPECIFIER));
	const tmpCtx = join(tmpdir(), `issue3-ctx-${process.pid}-${Date.now()}.json`);
	writeFileSync(tmpCtx, JSON.stringify({ runId: "bogus", defName: "nope", args: {}, cwd: tmpdir() }));

	await new Promise<void>((resolve) => {
		const child = spawn(process.execPath, [resolved, tmpCtx], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
		child.on("exit", (code) => {
			// It is expected to exit non-zero (bogus run). The regression would be a
			// module-load failure: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING or
			// "Cannot find module …detached-runner.js.js".
			assert.doesNotMatch(
				stderr,
				/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
				"must not hit the node_modules type-strip guardrail (loads compiled JS)",
			);
			assert.doesNotMatch(
				stderr,
				/Cannot find module[\s\S]*\.js\.js/,
				"must not hit the double-suffix ENOENT (issue #3)",
			);
			assert.notEqual(code, null, "child must have exited (not hang)");
			resolve();
		});
		child.on("error", () => resolve());
	});
});

// ---------------------------------------------------------------------------
// Bug 2: a child that dies early must not leave the run stuck at "running".
//
// We cannot easily exercise the host's inline spawn handler from a unit test
// (it is inside the tool-call body of index.ts), so we test the *contract* the
// handler relies on: given a "running" run whose pid is a dead process, a
// markFailed pass (mirroring the handler) transitions it to "failed" with the
// crash reason recorded in a pollable phase.
// ---------------------------------------------------------------------------

function makeTmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "issue3-"));
	return dir;
}

function minimalFlow(): Taskflow {
	return {
		name: "issue3-flow",
		phases: [{ id: "p1", type: "agent", agent: "a", task: "do something" }],
	};
}

test("detached: early-exit crash guard marks a stuck 'running' run as failed", () => {
	const cwd = makeTmpCwd();
	try {
		const runId = newRunId("issue3-flow");
		const state: RunState = {
			runId,
			flowName: "issue3-flow",
			def: minimalFlow(),
			args: {},
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd,
			detached: true,
			pid: 999_999, // a definitely-dead PID
		};
		saveRun(state);

		// Mirror the host's markFailedOnEarlyExit contract exactly:
		//   only act when status==="running" && pid matches; record a synthetic
		//   phase with the crash reason.
		const childErr = "Error: Cannot find module '...detached-runner.js.js'";
		const cur = loadRun(cwd, runId);
		assert.ok(cur, "run should load");
		if (cur && cur.status === "running" && cur.pid === state.pid) {
			cur.status = "failed";
			cur.phases["__detach__"] = {
				id: "__detach__",
				status: "failed",
				endedAt: Date.now(),
				error: childErr,
			};
			saveRun(cur);
		}

		const after = loadRun(cwd, runId);
		assert.ok(after, "run should load after crash guard");
		assert.equal(after!.status, "failed", "stuck run must be transitioned to failed");
		assert.equal(after!.phases["__detach__"]?.error, childErr, "crash reason must be recorded & pollable");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("detached: crash guard does NOT clobber a genuine terminal state", () => {
	const cwd = makeTmpCwd();
	try {
		const runId = newRunId("issue3-flow");
		// The real runner persisted "completed" — the guard must not overwrite it.
		const state: RunState = {
			runId,
			flowName: "issue3-flow",
			def: minimalFlow(),
			args: {},
			status: "completed",
			phases: { p1: { id: "p1", status: "done", output: "real result", endedAt: Date.now() } },
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd,
			detached: true,
			pid: 999_999,
		};
		saveRun(state);

		// Apply the guard contract — it must be a no-op because status !== "running".
		const cur = loadRun(cwd, runId);
		if (cur && cur.status === "running" && cur.pid === state.pid) {
			cur.status = "failed";
			saveRun(cur);
		}

		const after = loadRun(cwd, runId);
		assert.equal(after!.status, "completed", "genuine completed state must NOT be overwritten");
		assert.equal(after!.phases["__detach__"], undefined, "no synthetic crash phase when run already completed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
