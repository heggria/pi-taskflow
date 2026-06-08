/**
 * Tests for extensions/init.ts — model-role configuration.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach, afterEach } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	INIT_ROLES,
	RECOMMENDED_DEFAULTS,
	getSettingsPath,
	readSettings,
	writeSettings,
	formatModelOption,
	buildRoleOptions,
	parseCustomModel,
	diffRoles,
	formatRolesReport,
	formatDiffReport,
	runInteractiveInit,
} from "../extensions/init.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function makeTmpDir(prefix = "init-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a minimal mock Model<Api> for testing. */
function mockModel(
	provider: string,
	id: string,
	name: string,
	opts: { reasoning?: boolean; input?: ("text" | "image")[] } = {},
): Model<Api> {
	return {
		id,
		name,
		provider,
		reasoning: opts.reasoning ?? false,
		input: opts.input ?? ["text"],
		api: "openai-completions" as Api,
		baseUrl: "",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

/** Build a minimal mock ExtensionUIContext that records calls. */
interface MockUI {
	selectCalls: Array<{ title: string; options: string[] }>;
	inputCalls: Array<{ title: string; placeholder?: string }>;
	notifyCalls: Array<{ message: string; type?: string }>;
	/** Queue of canned responses. Undefined simulates Esc. */
	answers: Array<string | undefined>;
}

function createMockUI(answers: Array<string | undefined> = []): MockUI & ExtensionUIContext {
	const ui: MockUI = {
		selectCalls: [],
		inputCalls: [],
		notifyCalls: [],
		answers: [...answers],
	};
	return Object.assign(ui as unknown as ExtensionUIContext, {
		async select(title: string, options: string[], _opts?: unknown) {
			ui.selectCalls.push({ title, options });
			return ui.answers.shift();
		},
		async input(title: string, placeholder?: string, _opts?: unknown) {
			ui.inputCalls.push({ title, placeholder });
			return ui.answers.shift();
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			ui.notifyCalls.push({ message, type });
		},
	}) as MockUI & ExtensionUIContext;
}

// ---------------------------------------------------------------------------
// Per-test sandbox
// ---------------------------------------------------------------------------

let tmpRoot: string;
let agentDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
	tmpRoot = makeTmpDir();
	agentDir = path.join(tmpRoot, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	savedEnv = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
	if (savedEnv !== undefined) {
		process.env[AGENT_DIR_ENV] = savedEnv;
	} else {
		delete process.env[AGENT_DIR_ENV];
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// INIT_ROLES
// ---------------------------------------------------------------------------

test("INIT_ROLES: every role has non-empty description AND non-empty defaultModel", () => {
	for (const r of INIT_ROLES) {
		assert.ok(r.role.length > 0, `role key is empty for ${JSON.stringify(r)}`);
		assert.ok(r.description.length > 0, `description is empty for ${r.role}`);
		assert.ok(r.defaultModel.length > 0, `defaultModel is empty for ${r.role}`);
	}
});

// ---------------------------------------------------------------------------
// RECOMMENDED_DEFAULTS
// ---------------------------------------------------------------------------

test("RECOMMENDED_DEFAULTS: derived from INIT_ROLES, not stored separately", () => {
	const expected: Record<string, string> = {};
	for (const r of INIT_ROLES) {
		expected[r.role] = r.defaultModel;
	}
	assert.deepEqual(RECOMMENDED_DEFAULTS, expected);
});

// ---------------------------------------------------------------------------
// formatModelOption
// ---------------------------------------------------------------------------

test("formatModelOption: includes name + provider/id", () => {
	const m = mockModel("openrouter", "deepseek/v4-flash", "DeepSeek V4 Flash");
	const result = formatModelOption(m);
	assert.ok(result.includes("DeepSeek V4 Flash"), "should include name");
	assert.ok(result.includes("openrouter/deepseek/v4-flash"), "should include provider/id");
});

test("formatModelOption: adds reasoning tag when model.reasoning is true", () => {
	const m = mockModel("openrouter", "x/y", "X", { reasoning: true });
	assert.ok(formatModelOption(m).includes("reasoning ✓"));
});

test("formatModelOption: adds image tag when model.input includes 'image'", () => {
	const m = mockModel("openrouter", "x/y", "X", { input: ["text", "image"] });
	assert.ok(formatModelOption(m).includes("image ✓"));
});

test("formatModelOption: omits modality tag for text-only models", () => {
	const m = mockModel("openrouter", "x/y", "X", { input: ["text"] });
	const result = formatModelOption(m);
	assert.ok(!result.includes("image ✓"));
	assert.ok(!result.includes("reasoning ✓"));
});

// ---------------------------------------------------------------------------
// buildRoleOptions
// ---------------------------------------------------------------------------

const sampleModels: Model<Api>[] = [
	mockModel("openrouter", "deepseek/v4-flash", "DeepSeek V4 Flash", { reasoning: false }),
	mockModel("openrouter", "deepseek/v4-pro", "DeepSeek V4 Pro", { reasoning: true }),
	mockModel("openrouter", "anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", {
		reasoning: true,
		input: ["text", "image"],
	}),
	mockModel("minimax", "MiniMax-M3", "MiniMax M3", { reasoning: true, input: ["text", "image"] }),
	mockModel("openrouter", "openai/gpt-5", "GPT-5", { reasoning: false, input: ["text", "image"] }),
];

test("buildRoleOptions: marks current pick with '(current)'", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {
		current: "openrouter/deepseek/v4-flash",
	});
	assert.ok(options.some((o) => o.includes("(current)")));
});

test("buildRoleOptions: marks recommended pick with '(recommended)'", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {
		recommended: "openrouter/deepseek/v4-flash",
	});
	assert.ok(options.some((o) => o.includes("(recommended)")));
});

test("buildRoleOptions: includes separator, Custom, and Back entries", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {});
	assert.ok(options.includes("───────────────"), "separator");
	assert.ok(options.includes("Custom (type your own)"), "Custom");
	assert.ok(options.includes("Back to action menu"), "Back");
});

test("buildRoleOptions: vision role filters out text-only models", () => {
	const visionRole = INIT_ROLES.find((r) => r.role === "vision")!;
	const options = buildRoleOptions(visionRole, sampleModels, {});
	// DeepSeek V4 Flash and V4 Pro are text-only, should be filtered
	assert.ok(!options.some((o) => o.includes("v4-flash")), "text-only v4-flash filtered");
	assert.ok(!options.some((o) => o.includes("v4-pro")), "text-only v4-pro filtered");
	// Claude Sonnet and MiniMax M3 should be present
	assert.ok(options.some((o) => o.includes("claude-sonnet-4-6")), "image model present");
	assert.ok(options.some((o) => o.includes("MiniMax-M3")), "image model present");
});

test("buildRoleOptions: thinker role sorts reasoning=true models first", () => {
	const thinkerRole = INIT_ROLES.find((r) => r.role === "thinker")!;
	const options = buildRoleOptions(thinkerRole, sampleModels, {});
	// The first real option (before separator) should be a reasoning model
	const firstOption = options[0];
	assert.ok(firstOption.includes("reasoning ✓"), `first option should be reasoning: ${firstOption}`);
});

// ---------------------------------------------------------------------------
// buildRoleOptions (empty state)
// ---------------------------------------------------------------------------

test("buildRoleOptions: ctx.current undefined → no 'Keep current' entry", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {});
	assert.ok(!options.includes("Keep current"), "should not have 'Keep current' when ctx.current is undefined");
});

test("buildRoleOptions: ctx.current set → 'Keep current' entry present", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {
		current: "openrouter/deepseek/v4-flash",
	});
	assert.ok(options.includes("Keep current"), "should have 'Keep current' when ctx.current is set");
});

// ---------------------------------------------------------------------------
// parseCustomModel
// ---------------------------------------------------------------------------

test("parseCustomModel: parses 'openrouter/xiaomi/mimo-v2.5-pro'", () => {
	const result = parseCustomModel("openrouter/xiaomi/mimo-v2.5-pro");
	assert.deepEqual(result, { provider: "openrouter", id: "xiaomi/mimo-v2.5-pro" });
});

test("parseCustomModel: parses 'vercel-ai-gateway/anthropic/claude-sonnet-4-6' (3+ segments)", () => {
	const result = parseCustomModel("vercel-ai-gateway/anthropic/claude-sonnet-4-6");
	assert.deepEqual(result, { provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-4-6" });
});

test("parseCustomModel: rejects 'no-slash'", () => {
	assert.equal(parseCustomModel("no-slash"), null);
});

test("parseCustomModel: rejects empty string", () => {
	assert.equal(parseCustomModel(""), null);
});

test("parseCustomModel: rejects 'provider/' (empty id)", () => {
	assert.equal(parseCustomModel("provider/"), null);
});

// ---------------------------------------------------------------------------
// diffRoles
// ---------------------------------------------------------------------------

test("diffRoles: unchanged / changed / new / stale-preserved correctly classified", () => {
	const catalog = [{ role: "a" }, { role: "b" }, { role: "c" }];
	const before = { a: "x", b: "y", stale: "s" };
	const after = { a: "x", b: "z", c: "new" };
	const diffs = diffRoles(before, after, catalog);

	assert.equal(diffs.length, 4); // a, b, c + stale
	const a = diffs.find((d) => d.role === "a")!;
	assert.equal(a.status, "unchanged");
	assert.equal(a.before, "x");
	assert.equal(a.after, "x");

	const b = diffs.find((d) => d.role === "b")!;
	assert.equal(b.status, "changed");
	assert.equal(b.before, "y");
	assert.equal(b.after, "z");

	const c = diffs.find((d) => d.role === "c")!;
	assert.equal(c.status, "new");
	assert.equal(c.after, "new");

	const stale = diffs.find((d) => d.role === "stale")!;
	assert.equal(stale.status, "stale-preserved");
	assert.equal(stale.before, "s");
});

test("diffRoles: diff order matches INIT_ROLES order, with unknown roles appended", () => {
	const catalog = INIT_ROLES;
	const before: Record<string, string> = {};
	const after: Record<string, string> = {};
	for (const r of INIT_ROLES) {
		before[r.role] = r.defaultModel;
		after[r.role] = r.defaultModel;
	}
	before["custom-role"] = "x";
	const diffs = diffRoles(before, after, catalog);
	// All catalog roles first, then stale
	for (let i = 0; i < catalog.length; i++) {
		assert.equal(diffs[i].role, catalog[i].role);
		assert.equal(diffs[i].status, "unchanged");
	}
	assert.equal(diffs[diffs.length - 1].role, "custom-role");
	assert.equal(diffs[diffs.length - 1].status, "stale-preserved");
});

// ---------------------------------------------------------------------------
// readSettings / writeSettings
// ---------------------------------------------------------------------------

test("readSettings: missing file returns {}", () => {
	// Ensure the settings file does not exist in our test dir
	const sp = getSettingsPath();
	if (fs.existsSync(sp)) fs.unlinkSync(sp);
	const result = readSettings();
	assert.deepEqual(result, {});
});

test("readSettings: malformed JSON throws", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(sp, "not json {{{", "utf-8");
	assert.throws(() => readSettings());
});

test("readSettings: modelRoles: [] (array) returns {} for modelRoles", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(
		sp,
		JSON.stringify({ modelRoles: [] }),
		"utf-8",
	);
	const result = readSettings();
	assert.deepEqual(result.modelRoles, {});
});

test("readSettings: modelRoles: '' (string) returns {} for modelRoles", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(
		sp,
		JSON.stringify({ modelRoles: "" }),
		"utf-8",
	);
	const result = readSettings();
	assert.deepEqual(result.modelRoles, {});
});

test("readSettings: modelRoles: 'string' returns {} for modelRoles", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(
		sp,
		JSON.stringify({ modelRoles: "string" }),
		"utf-8",
	);
	const result = readSettings();
	assert.deepEqual(result.modelRoles, {});
});

test("readSettings/writeSettings: round-trip preserves non-modelRoles keys", () => {
	const settings = {
		modelRoles: { fast: "a/b" },
		subagents: { agentOverrides: { executor: { model: "x/y" } } },
		enabledModels: ["a/b", "c/d"],
	};
	writeSettings(settings);
	const result = readSettings();
	assert.deepEqual(result.subagents, { agentOverrides: { executor: { model: "x/y" } } });
	assert.deepEqual(result.enabledModels, ["a/b", "c/d"]);
});

test("writeSettings: atomic write uses unique tmp and cleans up", () => {
	// writeSettings should succeed and produce a valid JSON file
	writeSettings({ modelRoles: { fast: "test" } });
	const sp = getSettingsPath();
	const content = JSON.parse(fs.readFileSync(sp, "utf-8"));
	assert.deepEqual(content, { modelRoles: { fast: "test" } });
	// No leftover .tmp files in the directory
	const dir = path.dirname(sp);
	const files = fs.readdirSync(dir);
	const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
	assert.equal(tmpFiles.length, 0, `leftover tmp files: ${tmpFiles.join(", ")}`);
});

// ---------------------------------------------------------------------------
// formatRolesReport
// ---------------------------------------------------------------------------

test("formatRolesReport: empty current shows message about no config", () => {
	const report = formatRolesReport({});
	assert.ok(report.includes("No modelRoles configured"));
});

test("formatRolesReport: populated current shows all roles", () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	const report = formatRolesReport(current);
	for (const r of INIT_ROLES) {
		assert.ok(report.includes(r.role), `missing role ${r.role}`);
		assert.ok(report.includes(r.defaultModel), `missing model for ${r.role}`);
	}
});

// ---------------------------------------------------------------------------
// formatDiffReport
// ---------------------------------------------------------------------------

test("formatDiffReport: shows all diff statuses", () => {
	const before: Record<string, string> = { fast: "a/b", stale: "x/y" };
	const after: Record<string, string> = { fast: "a/b", strong: "new/model" };
	// Fill other roles with same value
	for (const r of INIT_ROLES) {
		if (r.role !== "fast" && r.role !== "strong") {
			before[r.role] = r.defaultModel;
			after[r.role] = r.defaultModel;
		}
	}
	const report = formatDiffReport(before, after);
	assert.ok(report.includes("unchanged"), "should show unchanged");
	assert.ok(report.includes("new"), "should show new");
	assert.ok(report.includes("stale"), "should show stale-preserved");
});

// ---------------------------------------------------------------------------
// runInteractiveInit (mocked UI)
// ---------------------------------------------------------------------------

test("runInteractiveInit: empty currentRoles → 2-option action menu", async () => {
	const ui = createMockUI(["Configure each role", ...INIT_ROLES.map(() => "Keep current"), "Save these changes"]);
	const modelList = sampleModels;
	await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList,
		currentRoles: {},
	});
	// First select call should be the action menu
	const firstSelect = ui.selectCalls[0];
	assert.ok(firstSelect.title.includes("What do you want to do"));
	// Should only have 2 options (no "Edit one role", "Show current roles", "Cancel")
	assert.equal(firstSelect.options.length, 2);
	assert.ok(firstSelect.options.includes("Use recommended defaults"));
	assert.ok(firstSelect.options.includes("Configure each role"));
});

test("runInteractiveInit: 'Use recommended defaults' → saves RECOMMENDED_DEFAULTS", async () => {
	const ui = createMockUI(["Use recommended defaults"]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: {},
	});
	assert.equal(result.kind, "saved");
	if (result.kind === "saved") {
		assert.deepEqual(result.chosen, RECOMMENDED_DEFAULTS);
		assert.ok(result.savedPath.length > 0);
	}
});

test("runInteractiveInit: 'Configure each role' with all 'Keep current' → no-change", async () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	// All picks are "Keep current", then preview should not appear
	const ui = createMockUI(["Configure each role", ...INIT_ROLES.map(() => "Keep current")]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(result.kind, "no-change");
	if (result.kind === "no-change") {
		assert.deepEqual(result.chosen, current);
	}
	// No preview dialog should have appeared (short-circuit)
	assert.ok(!ui.selectCalls.some((c) => c.title.includes("Review changes")));
});

test("runInteractiveInit: 'Cancel' on action menu → cancelled", async () => {
	const ui = createMockUI(["Cancel"]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: { fast: "a/b" },
	});
	assert.equal(result.kind, "cancelled");
});

test("runInteractiveInit: Esc on action menu (undefined return) → cancelled", async () => {
	const ui = createMockUI([undefined as unknown as string]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: { fast: "a/b" },
	});
	assert.equal(result.kind, "cancelled");
});

test("runInteractiveInit: custom model not in registry → still saves, warns", async () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	// Select "Edit one role", pick the first role, choose Custom, type a custom model, then save
	const ui = createMockUI([
		"Edit one role",
		INIT_ROLES[0].role + " — " + INIT_ROLES[0].description,
		"Custom (type your own)",
		"myprovider/my-custom-model",
		"Save these changes",
	]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(result.kind, "saved");
	if (result.kind === "saved") {
		assert.equal(result.chosen[INIT_ROLES[0].role], "myprovider/my-custom-model");
	}
});
