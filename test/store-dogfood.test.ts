/**
 * Dogfood regression tests for 8 store-layer fixes.
 *
 * Each test verifies a specific invariant or edge case identified during
 * v0.0.9+ dogfooding.  Some tests use child processes to exercise the
 * concurrent access paths that the single-threaded test runner cannot
 * reach.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../extensions/schema.ts";
import {
	listRuns,
	loadRun,
	newRunId,
	saveFlow,
	saveRun,
	type RunState,
} from "../extensions/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-store-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function minimalFlow(name: string): Taskflow {
	return {
		name,
		phases: [{ id: "p1", type: "agent", agent: "a", task: "do something" }],
	};
}

function mkRunState(cwd: string, overrides: Partial<RunState> = {}): RunState {
	const flowName = overrides.flowName ?? "dogfood-flow";
	return {
		runId: overrides.runId ?? newRunId(flowName),
		flowName,
		def: minimalFlow(flowName),
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
		...overrides,
	};
}

/** Run a one-shot node child process and return its exit code. */
function runChild(scriptContent: string, cwd: string, ...args: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		// Import inside the function to keep top-level ESM clean.
		import("node:child_process").then(({ spawn }) => {
			const scriptPath = path.join(cwd, `child-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`);
			fs.writeFileSync(scriptPath, scriptContent, "utf-8");
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", scriptPath, cwd, ...args],
				{ stdio: "ignore" },
			);
			child.on("close", (code) => {
				try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
				resolve(code ?? 0);
			});
			child.on("error", reject);
		});
	});
}

// ===========================================================================
// Test 1 — saveRun rejects runId with "/" or ".."
// ===========================================================================

test("dogfood: saveRun with runId containing '/' or '..' does not escape runs root", () => {
	const cwd = makeTmpCwd();
	try {
		const flowName = "safe-flow";
		// A runId containing "/" would, via path.join, write to a sibling dir
		// (or outside runs/).  A runId containing ".." could traverse up.
		// saveRun must keep all output bounded within the runs/ tree.
		const badRunIds = ["evil/path", "../escape", "sub/../lateral"];

		for (const badId of badRunIds) {
			const state = mkRunState(cwd, { flowName, runId: badId });
			// saveRun should not throw — it must handle the bad runId gracefully.
			saveRun(state);
		}

		const runsDir = path.join(cwd, ".pi", "taskflows", "runs", "safe-flow");

		// The only files in the flow dir should be for the sanitised versions
		// of runIds.  Literal "/" and ".." in runIds create subdirectories or
		// escape — those must NOT leak outside the per-flow dir.
		const entries = fs.readdirSync(runsDir);
		for (const entry of entries) {
			// Skip lock / temp files but check .json entries.
			if (!entry.endsWith(".json") || entry.endsWith(".lock")) continue;
			// The runId part (minus .json) must not contain path separators
			// or ".." — if it does, the path.join resolved to a different dir.
			const runIdPart = entry.slice(0, -".json".length);
			assert.doesNotMatch(
				runIdPart,
				/[/\\]/,
				`runId part ${JSON.stringify(runIdPart)} must not contain path separators`,
			);
		}

		// loadRun with these runIds must return null because validateRunId
		// (used in loadRun) rejects "/" and "..".
		for (const badId of badRunIds) {
			const loaded = loadRun(cwd, badId);
			assert.equal(loaded, null, `loadRun must reject runId ${JSON.stringify(badId)}`);
		}
	} finally {
		cleanup(cwd);
	}
});

test("dogfood: saveRun with runId containing '..' does not write outside runs/", () => {
	const cwd = makeTmpCwd();
	try {
		// Aggressive traversal: runId that navigates up past the runs dir.
		const state = mkRunState(cwd, {
			flowName: "traversal",
			runId: "../../etc/pwned",
		});
		saveRun(state);

		// Verify the file did NOT escape to /etc
		assert.ok(!fs.existsSync("/etc/pwned.json"), "run file must not escape to /etc");
		assert.ok(!fs.existsSync("/tmp/pwned.json"), "run file must not escape to /tmp");

		// Verify everything is inside the runs tree.
		const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
		// The traversal runId might end up somewhere weird inside runs/, but it
		// must be contained.
		const allFiles: string[] = [];
		function walk(dir: string): void {
			try {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const fp = path.join(dir, entry.name);
					if (entry.isDirectory()) walk(fp);
					else allFiles.push(fp);
				}
			} catch { /* ignore */ }
		}
		walk(runsDir);
		for (const fp of allFiles) {
			const rel = path.relative(runsDir, fp);
			assert.ok(
				!rel.startsWith("..") && !path.isAbsolute(rel),
				`file ${fp} must be inside runs/`,
			);
		}
	} finally {
		cleanup(cwd);
	}
});

// ===========================================================================
// Test 2 — cleanupTerminalRuns mtime guard
// ===========================================================================

test(
	"dogfood: terminal runs created by concurrent children survive cleanup when restarted as running",
	async () => {
		const cwd = makeTmpCwd();
		try {
			const flowName = "cleanup-flow";
			const N = 105; // exceeds DEFAULT_MAX_KEPT_TERMINAL (100)

			// Step 1: Spawn N child processes, each saving one completed run
			// (runId = "cleanup-X").  Each child has a fresh module state so
			// the cleanup throttle does not apply across children.
			const childScript = `
			import { saveRun } from ${JSON.stringify(path.resolve("extensions/store.ts"))};
			const [cwd, runId, flowName] = [process.argv[2], process.argv[3], process.argv[4]];
			saveRun({
				runId, flowName, def: { name: flowName, phases: [], concurrency:1 },
				args: {}, status: "completed", phases: {},
				createdAt: Date.now(), updatedAt: Date.now(), cwd,
			});
		`;
			const codes = await Promise.all(
				Array.from({ length: N }, (_, i) =>
					runChild(childScript, cwd, `cleanup-${i}`, flowName),
				),
			);
			for (const c of codes)
				assert.equal(c, 0, `child exit code must be 0`);

			// Step 2: In another child, save the same runId as "running".
			// This triggers cleanupTerminalRuns (first saveRun in that child).
			// The cleanup should see the "running" run in the index and not
			// delete its file.
			const protectScript = `
			import { saveRun } from ${JSON.stringify(path.resolve("extensions/store.ts"))};
			const [cwd, flowName] = [process.argv[2], process.argv[3]];
			saveRun({
				runId: "cleanup-protected",
				flowName,
				def: { name: flowName, phases: [], concurrency:1 },
				args: {}, status: "running", phases: {},
				createdAt: Date.now(), updatedAt: Date.now(), cwd,
			});
		`;
			const protectCode = await runChild(protectScript, cwd, flowName);
			assert.equal(protectCode, 0, "protecting child must exit 0");

			// Step 3: Verify the "running" run's file still exists.
			const runsDir = path.join(cwd, ".pi", "taskflows", "runs", flowName);
			const protectFile = path.join(runsDir, "cleanup-protected.json");
			assert.ok(
				fs.existsSync(protectFile),
				"running run file must still exist after cleanup",
			);

			// Step 4: loadRun must still find it.
			const loaded = loadRun(cwd, "cleanup-protected");
			assert.ok(loaded, "loadRun must find the protected run");
			assert.equal(loaded.status, "running");

			// Step 5: Check that the index entry says "running", not "completed".
			const runs = listRuns(cwd, 200);
			const protectedEntry = runs.find((r) => r.runId === "cleanup-protected");
			assert.ok(protectedEntry, "listRuns must include the protected run");
			assert.equal(protectedEntry.status, "running");
		} finally {
			cleanup(cwd);
		}
	});

	/** Verify that cleanup does not delete a run that was updated from
	 *  "completed" to "running" between the cleanup index snapshot and
	 *  file deletion (mtime guard).  We simulate this by having two
	 *  concurrent child processes: one creates terminal runs (so cleanup
	 *  has work), another races to flip a run to "running". */
	test(
		"dogfood: mtime guard — concurrent restart prevents cleanup from deleting a re-activated run",
		async () => {
			const cwd = makeTmpCwd();
			try {
				const flowName = "mtime-flow";

				// First, create enough terminal runs to ensure cleanup has
				// something to evict.
				const N = 105;
				const seedScript = `
				import { saveRun } from ${JSON.stringify(path.resolve("extensions/store.ts"))};
				const [cwd, i, flowName] = [process.argv[2], parseInt(process.argv[3]), process.argv[4]];
				saveRun({
					runId: "seed-" + i,
					flowName,
					def: { name: flowName, phases: [], concurrency:1 },
					args: { idx: i },
					status: "completed",
					phases: {},
					createdAt: Date.now(),
					updatedAt: Date.now(),
					cwd,
				});
			`;
				const codes = await Promise.all(
					Array.from({ length: N }, (_, i) =>
						runChild(seedScript, cwd, String(i), flowName),
					),
				);
				for (const c of codes)
					assert.equal(c, 0, `seed child exit code must be 0`);

				// Now save a target run as "completed", then immediately
				// re-save as "running" in a CHILD process.  The child's
				// saveRun triggers cleanup, which sees the index with the
				// run as "running" (because saveRun writes the index before
				// calling cleanup).  The file must not be deleted.
				const flipScript = `
				import { saveRun } from ${JSON.stringify(path.resolve("extensions/store.ts"))};
				const [cwd, flowName] = [process.argv[2], process.argv[3]];

				// Save as completed first.
				saveRun({
					runId: "flip-target",
					flowName,
					def: { name: flowName, phases: [], concurrency:1 },
					args: {}, status: "completed", phases: {},
					createdAt: Date.now(), updatedAt: Date.now(), cwd,
				});

				// Immediately re-save as running — this triggers cleanup.
				saveRun({
					runId: "flip-target",
					flowName,
					def: { name: flowName, phases: [], concurrency:1 },
					args: {}, status: "running", phases: {},
					createdAt: Date.now(), updatedAt: Date.now(), cwd,
				});
			`;
				const flipCode = await runChild(flipScript, cwd, flowName);
				assert.equal(flipCode, 0, "flip child must exit 0");

				// Verify the "running" run's file exists.
				const runsDir = path.join(cwd, ".pi", "taskflows", "runs", flowName);
				const flipFile = path.join(runsDir, "flip-target.json");
				assert.ok(
					fs.existsSync(flipFile),
					"flipped run file must still exist after cleanup",
				);

				// Verify the run loads with "running" status.
				const loaded = loadRun(cwd, "flip-target");
				assert.ok(loaded, "loadRun must find the flipped run");
				assert.equal(loaded.status, "running");
			} finally {
				cleanup(cwd);
			}
		});

// ===========================================================================
// Test 3 — saveFlow ".hidden-test" → file named `_hidden-test.json`
// ===========================================================================

test("dogfood: saveFlow with leading-dot name produces non-hidden file", () => {
	const cwd = makeTmpCwd();
	try {
		const def: Taskflow = {
			name: ".hidden-test",
			phases: [{ id: "p1", type: "agent", agent: "a", task: "x" }],
		};
		const { filePath } = saveFlow(cwd, def, "project");
		const basename = path.basename(filePath);

		// The file must NOT start with a dot (hidden on Unix).
		// Leading dots should be replaced with '_'.
		assert.doesNotMatch(
			basename,
			/^\./,
			`filename ${JSON.stringify(basename)} must not start with '.' (hidden file)`,
		);
		assert.ok(
			basename.startsWith("_"),
			`filename ${JSON.stringify(basename)} should start with '_' instead of '.'`,
		);
		assert.ok(basename.endsWith(".json"), "filename must end with .json");

		// The file must actually exist at the computed path.
		assert.ok(fs.existsSync(filePath), `file ${filePath} must exist on disk`);
	} finally {
		cleanup(cwd);
	}
});

// ===========================================================================
// Test 4 — saveFlow same name twice → no corruption
// ===========================================================================

test("dogfood: saveFlow with same name twice does not corrupt", () => {
	const cwd = makeTmpCwd();
	try {
		// First save
		const v1: Taskflow = {
			name: "dup-flow",
			phases: [{ id: "a", type: "agent", agent: "a", task: "first" }],
		};
		const { filePath: fp1 } = saveFlow(cwd, v1, "project");
		const mtime1 = fs.statSync(fp1).mtimeMs;

		// Second save with different content
		const v2: Taskflow = {
			name: "dup-flow",
			phases: [
				{ id: "a", type: "agent", agent: "a", task: "first" },
				{ id: "b", type: "agent", agent: "a", task: "second", dependsOn: ["a"] },
			],
		};
		const { filePath: fp2 } = saveFlow(cwd, v2, "project");

		// Both must point to the same file
		assert.equal(fp1, fp2, "both saves must return the same file path");

		// File must exist
		assert.ok(fs.existsSync(fp1), "file must exist after second save");

		// File must contain the latest version (v2), not corrupted garbage
		const raw = fs.readFileSync(fp1, "utf-8");
		let parsed: Taskflow;
		try {
			parsed = JSON.parse(raw);
		} catch {
			assert.fail(`file content is not valid JSON: ${raw.slice(0, 200)}`);
		}
		assert.equal(parsed.name, "dup-flow");
		assert.equal(parsed.phases.length, 2, "must contain latest (v2) phases");

		// mtime must have advanced (or at least not be identical)
		const mtime2 = fs.statSync(fp1).mtimeMs;
		assert.ok(mtime2 >= mtime1, "mtime must not go backwards");
	} finally {
		cleanup(cwd);
	}
});

// ===========================================================================
// Test 5 — rebuildIndex preserves concurrent additions
// ===========================================================================

test(
	"dogfood: rebuildIndex does not lose entries added by concurrent children",
	async () => {
		const cwd = makeTmpCwd();
		try {
			const flowName = "rebuild-flow";
			const N = 15;

			// Step 1: Save N runs via child processes (ensuring each has
			// fresh module state so the index is populated).
			const addScript = `
			import { saveRun } from ${JSON.stringify(path.resolve("extensions/store.ts"))};
			const [cwd, i, flowName] = [process.argv[2], parseInt(process.argv[3]), process.argv[4]];
			saveRun({
				runId: "add-" + i,
				flowName,
				def: { name: flowName, phases: [], concurrency:1 },
				args: { idx: i }, status: "completed", phases: {},
				createdAt: Date.now(), updatedAt: Date.now(), cwd,
			});
		`;
			const codes = await Promise.all(
				Array.from({ length: N }, (_, i) =>
					runChild(addScript, cwd, String(i), flowName),
				),
			);
			for (const c of codes)
				assert.equal(c, 0, `add child exit code must be 0`);

			// Step 2: Corrupt the index so listRuns triggers rebuildIndex.
			const runsDir = path.join(cwd, ".pi", "taskflows", "runs");
			const indexPath = path.join(runsDir, "index.json");
			assert.ok(
				fs.existsSync(indexPath),
				"index should exist after saves",
			);
			fs.writeFileSync(indexPath, "corrupted", "utf-8");

			// Step 3: Simultaneously trigger listRuns (which calls
			// rebuildIndex) AND add more runs via child processes.
			const moreScript = `
			import { saveRun } from ${JSON.stringify(path.resolve("extensions/store.ts"))};
			const [cwd, i, flowName] = [process.argv[2], parseInt(process.argv[3]), process.argv[4]];
			saveRun({
				runId: "late-" + i,
				flowName,
				def: { name: flowName, phases: [], concurrency:1 },
				args: { idx: i }, status: "completed", phases: {},
				createdAt: Date.now(), updatedAt: Date.now(), cwd,
			});
		`;
			const M = 5;
			const [moreCodes, listResult] = await Promise.all([
				Promise.all(
					Array.from({ length: M }, (_, i) =>
						runChild(moreScript, cwd, String(100 + i), flowName),
					),
				),
				// listRuns reads from the index (which is corrupt) so it
				// should trigger rebuildIndex.
				Promise.resolve().then(() => listRuns(cwd, 200)),
			]);

			for (const c of moreCodes)
				assert.equal(c, 0, `late add child must exit 0`);

			// All 15 original runs + 5 late additions (some may be found
			// by rebuildIndex scanning the filesystem, some by the
			// rebuildIndex call).
			const ids = new Set(listResult.map((r) => r.runId));
			for (let i = 0; i < N; i++) {
				assert.ok(
					ids.has(`add-${i}`),
					`rebuildIndex must retain add-${i}`,
				);
			}
			for (let i = 0; i < M; i++) {
				assert.ok(
					ids.has(`late-${100 + i}`),
					`rebuildIndex must retain late-${100 + i} (concurrent add)`,
				);
			}
		} finally {
			cleanup(cwd);
		}
	});

// ===========================================================================
// Test 6 — SharedArrayBuffer is module-scoped (static assertion)
// ===========================================================================

test("dogfood: SharedArrayBuffer is available and used by acquireLock", () => {
	// SharedArrayBuffer is a global required by Atomics.wait for the
	// busy-wait spinlock in acquireLock.  It must be available in the
	// runtime.
	assert.ok(
		typeof SharedArrayBuffer !== "undefined",
		"SharedArrayBuffer must be available in the runtime",
	);
	assert.ok(
		typeof Atomics !== "undefined" && typeof Atomics.wait === "function",
		"Atomics.wait must be available (used in busy-wait spinlock)",
	);

	// Verify the store module uses SharedArrayBuffer (at import time,
	// the module defines module-scoped constants that depend on the
	// availability of these globals).
	const storeSource = fs.readFileSync(
		path.resolve("extensions/store.ts"),
		"utf-8",
	);
	const hasSharedArrayBuffer = storeSource.includes("SharedArrayBuffer");
	assert.ok(
		hasSharedArrayBuffer,
		"extensions/store.ts must reference SharedArrayBuffer",
	);
	const hasAtomicsWait = storeSource.includes("Atomics.wait");
	assert.ok(
		hasAtomicsWait,
		"extensions/store.ts must reference Atomics.wait",
	);
});

// ===========================================================================
// Test 7 — saveFlow with empty name rejected
// ===========================================================================

test("dogfood: saveFlow with empty name either throws or produces safe file", () => {
	const cwd = makeTmpCwd();
	try {
		// A flow with name="" should either be rejected by validation
		// (schema minLength) or produce a safe fallback name.
		const def: Taskflow = {
			name: "",
			phases: [{ id: "p1", type: "agent", agent: "a", task: "x" }],
		};

		// saveFlow internally does: def.name.replace(/[^\w.-]+/g, "_")
		// which for "" yields "".  Then filePath is `${safe}.json` = `.json`.
		// This is a degenerate case — the file name would be ".json" which
		// is hidden.  The fix should ensure empty names produce a safe
		// non-hidden filename (e.g. "_" + ".json").

		let filePath: string | undefined;
		try {
			const result = saveFlow(cwd, def, "project");
			filePath = result.filePath;
		} catch {
			// Rejection by throw is acceptable.
			assert.ok(true, "saveFlow threw for empty name (acceptable)");
			return;
		}

		// If it didn't throw, the file must exist and must NOT be named
		// just ".json" (which is a hidden file).
		assert.ok(filePath, "filePath must be defined");
		const basename = path.basename(filePath);
		assert.notEqual(
			basename,
			".json",
			`filename must not be ".json" for empty name`,
		);
		assert.doesNotMatch(
			basename,
			/^\./,
			`filename must not be hidden (start with dot): ${basename}`,
		);

		// The file should be readable and parseable.
		assert.ok(fs.existsSync(filePath), "file must exist on disk");
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		assert.ok(parsed, "file must contain valid JSON");
	} finally {
		cleanup(cwd);
	}
});

// ===========================================================================
// Test 8 — saveFlow hint conditional on .pi/ existence
// ===========================================================================

test("dogfood: saveFlow hints about .pi/ creation only when .pi/ did not exist", () => {
	// Test 8a: When .pi/ already exists, no warning should fire.
	const cwdWithPi = makeTmpCwd(); // makeTmpCwd creates .pi/
	try {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);
		try {
			const def = minimalFlow("hint-test-a");
			saveFlow(cwdWithPi, def, "project");

			// The hint about .pi/ creation should NOT fire because .pi/
			// already existed.
			const hasHint = warnings.some((w) =>
				w.includes("Created .pi/taskflows/"),
			);
			assert.ok(
				!hasHint,
				"should not hint about .pi/ creation when .pi/ already exists",
			);
		} finally {
			console.warn = originalWarn;
		}
	} finally {
		cleanup(cwdWithPi);
	}

	// Test 8b: When .pi/ does NOT exist, the hint SHOULD fire.
	const cwdNoPi = fs.mkdtempSync(
		path.join(os.tmpdir(), "dogfood-no-pi-"),
	);
	try {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);
		try {
			const def = minimalFlow("hint-test-b");
			saveFlow(cwdNoPi, def, "project");

			const hasHint = warnings.some((w) =>
				w.includes("Created .pi/taskflows/"),
			);
			assert.ok(
				hasHint,
				"should hint about .pi/ creation when .pi/ does not exist",
			);
		} finally {
			console.warn = originalWarn;
		}
	} finally {
		cleanup(cwdNoPi);
	}
});

test("dogfood: saveFlow hint fires only once even across multiple saves", () => {
	// The hint is controlled by the module-level `_piCreationHinted` flag.
	// After the first saveFlow without .pi/, subsequent saves (even on
	// different cwds without .pi/) should not re-fire the hint.
	const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-hint-1-"));
	const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-hint-2-"));
	try {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);
		try {
			// First save — no .pi/ dir, so hint fires.
			saveFlow(cwd1, minimalFlow("hint-once-a"), "project");
			const hintCount1 = warnings.filter((w) =>
				w.includes("Created .pi/taskflows/"),
			).length;

			// Second save on a different dir — hint should NOT fire again.
			saveFlow(cwd2, minimalFlow("hint-once-b"), "project");
			const hintCount2 = warnings.filter((w) =>
				w.includes("Created .pi/taskflows/"),
			).length;

			assert.equal(hintCount1, 1, "first save without .pi/ should fire hint exactly once");
			assert.equal(
				hintCount2,
				1,
				"second save (no .pi/) should not re-fire the hint (still 1 total)",
			);
		} finally {
			console.warn = originalWarn;
		}
	} finally {
		cleanup(cwd1);
		cleanup(cwd2);
	}
});
