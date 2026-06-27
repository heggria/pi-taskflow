/**
 * Subagent runner — spawns an isolated `pi --mode json -p` process for a single
 * task and collects its structured output and usage. Adapted from the pi
 * subagent extension's runSingleAgent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { emptyUsage, type UsageStats } from "./usage.ts";
import type { LiveUpdate, RunOptions, RunResult, SubagentRunner } from "./host/runner-types.ts";

// Re-export the host-neutral execution contract so every existing
// `import { RunResult, RunOptions, LiveUpdate } from "./runner.ts"` keeps
// working. The canonical definitions now live in ./host/runner-types.ts (the
// seam that lets pi-taskflow run on pi, Codex, …).
export type { LiveUpdate, RunOptions, RunResult, SubagentRunner } from "./host/runner-types.ts";

const activeChildren = new Set<number>();
const killAll = () => {
	for (const pid of activeChildren) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
	}
};
process.on("exit", killAll);
process.on("SIGTERM", () => { killAll(); process.exit(143); });

// `RunResult`, `LiveUpdate`, and `RunOptions` are defined in the host-neutral
// contract (./host/runner-types.ts) and re-exported above. Their JSDoc and the
// pi-specific notes (PI_TASKFLOW_CTX_DIR / --extension for ctx_* tools) live
// with the pi implementation below.

/**
 * Default idle-watchdog window. A subagent that emits nothing on stdout for this
 * long is treated as wedged and killed so a single stalled child cannot hang the
 * entire taskflow forever (the only previous escape was a manual user abort).
 * 5 minutes is generous enough for slow reasoning/long tool calls while still
 * bounding a true hang.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** The Shared Context Tree tool names a subagent may call when sharing is on. */
export const CTX_TOOL_NAMES = ["ctx_read", "ctx_write", "ctx_report", "ctx_spawn"] as const;

/**
 * Guidance appended to a subagent's system prompt when the Shared Context Tree
 * is enabled for its phase. Registering the ctx_* tools makes them AVAILABLE;
 * this block is what makes the model actually USE them with the right discipline
 * (read-before-you-explore; publish reusable findings; report up; delegate when
 * work fans out). Kept short and imperative on purpose.
 */
export const CTX_TOOLS_GUIDANCE = [
	"## Shared Context Tree (you are part of a coordinated team of agents)",
	"",
	"You are one agent in a tree working a shared goal, with a shared blackboard",
	"and an upward report channel. Use these tools deliberately \u2014 they save tokens",
	"and prevent the team from duplicating work:",
	"",
	"- ctx_read(key?): BEFORE exploring the codebase or re-reading files, call",
	"  ctx_read with no arguments to see what teammates already discovered. If a",
	"  finding you need already exists, REUSE it instead of re-deriving it.",
	"- ctx_write(key, value): when you discover something other agents will likely",
	"  need (a file map, an endpoint list, an interface, a config value), publish it",
	"  under a short key (e.g. 'endpoints', 'db.schema'). Keep values concise and",
	"  structured (JSON) so others can consume them directly.",
	"- ctx_report(summary, structured?): when you finish, report your result upward",
	"  so the parent task and downstream steps can see it. Lead with the outcome.",
	"- ctx_spawn(assignments[]): if you discover the work should fan out into",
	"  independent sub-tasks, delegate them as child agents. They run after you",
	"  finish and their reports are folded back into your output. Only spawn when it",
	"  genuinely parallelizes \u2014 otherwise just do the work yourself.",
	"",
	"Default habit: ctx_read first, do the work (reusing shared findings), ctx_write",
	"anything reusable, then ctx_report your result.",
].join("\n");

export function isFailed(r: RunResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/**
 * Heuristic: did this failure look like a transient/retryable provider error
 * (rate limit, overload, timeout, 5xx)? Such errors should be retried inside
 * the taskflow run with backoff rather than bubbled up — otherwise the calling
 * agent tends to re-invoke the whole tool, producing duplicate progress blocks.
 */
const TRANSIENT_ERROR_RE =
	/rate[_\s-]?limit|too\s+many\s+requests|overloaded|\b429\b|\b503\b|\b502\b|\b504\b|service\s+unavailable|temporarily\s+unavailable|timeout|timed?\s+out|econnreset|etimedout|socket\s+hang\s*up/i;
export function isTransientError(r: RunResult): boolean {
	if (r.stopReason === "aborted") return false;
	// Idle timeout is a deterministic stall — retrying won't help.
	if (r.stopReason === "error" && r.idleTimeout) return false;
	const hay = `${r.errorMessage ?? ""} ${r.stderr ?? ""} ${r.output ?? ""}`;
	return TRANSIENT_ERROR_RE.test(hay);
}

/** Placeholder written to a failed phase's `output` so downstream interpolation
 *  can detect "upstream failed" without being polluted by raw HTML/JSON. */
export const TRANSPORT_ERROR_PLACEHOLDER = "(upstream error: subagent failed; see error)";

/** Hard cap on the errorMessage field stored in PhaseState (≈ 4 KB). */
export const ERROR_MESSAGE_MAX_LEN = 4096;

/** Cheap HTML/JSON detector so we can summarize upstream garbage. */
export function looksLikeHtmlOrJson(s: string): boolean {
	const t = s.trimStart();
	if (!t) return false;
	if (t.startsWith("<")) {
		// HTML/XML/Cloudflare challenge pages
		return /^<(?:!doctype\s+html|html|head|body|script|svg|div|iframe|span|p)\b/i.test(t);
	}
	if (t.startsWith("{")) {
		// Truncated JSON. A genuine JSON envelope is fine to keep; an unwrapped
		// {error: "..."} from an SDK is short. We only treat it as "garbage" if
		// it parses and is huge — but that's caught by the size cap below.
		return false;
	}
	return false;
}

/**
 * Truncate and (when obviously HTML) summarize an errorMessage before it is
 * persisted. Returns the cleaned string. Empty input returns empty.
 */
export function sanitizeErrorMessage(raw: string | undefined): string {
	if (!raw) return "";
	const cleaned = raw.replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	// Decide the sanitization branch on the RAW length, not the whitespace-
	// collapsed length — otherwise an HTML page padded with spaces would slip
	// through the "looks like HTML" branch and be persisted as-is.
	const rawLen = raw.length;
	if (rawLen > ERROR_MESSAGE_MAX_LEN) {
		const head = cleaned.slice(0, 200);
		const tail = cleaned.slice(-200);
		return `${head} ... [truncated ${rawLen - 400} chars] ... ${tail}`;
	}
	if (looksLikeHtmlOrJson(cleaned)) {
		// Any document-like HTML (Cloudflare challenge pages, proxy error pages,
		// gateway error pages) is a strong signal the upstream returned a page
		// instead of JSON. Summarize it instead of letting HTML pollute the
		// phase's error and downstream interpolation contexts.
		const title = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
		const stripped = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		const m = stripped.match(/(?:Unable to load site|Ray ID[: ]+([A-Za-z0-9]+)|[A-Z][a-z]+Error[: ]+(.{0,200}))/i);
		const hint = title || (m ? (m[1] || m[0]).trim() : stripped.slice(0, 200));
		return `Upstream returned non-JSON response (${rawLen} chars). Hint: ${hint}`;
	}
	return cleaned;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

/** Accumulated state folded from a subagent's NDJSON event stream. */
export interface EventAccumulator {
	messages: Message[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	lastActivity: string;
	/** Set when message cap was hit — output gets a truncation notice. */
	truncated?: boolean;
}

export function newAccumulator(model?: string): EventAccumulator {
	return { messages: [], usage: emptyUsage(), model, lastActivity: "" };
}

/**
 * Fold one NDJSON line into the accumulator. Returns a LiveUpdate when an
 * assistant message ended (for streaming), else null. Empty, malformed, and
 * non-`message_end` lines are ignored — making the parser robust to partial
 * buffers/noise and unit-testable without spawning a process.
 */
export function foldEventLine(acc: EventAccumulator, line: string): LiveUpdate | null {
	if (!line.trim()) return null;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (event.type !== "message_end" || !event.message) return null;
	const msg = event.message as Message;
	// Cap prevents OOM from misconfigured loops. 500 messages is generous for
	// normal subagent tasks (50 turns × 10 messages each). Messages beyond the
	// cap are still parsed for usage/model/stopReason extraction.
	const MAX_MESSAGES = 500;
	if (acc.messages.length < MAX_MESSAGES) {
		acc.messages.push(msg);
	} else {
		acc.truncated = true;
	}
	if (msg.role !== "assistant") return null;
	acc.usage.turns++;
	const u = (msg as any).usage;
	if (u) {
		acc.usage.input += u.input || 0;
		acc.usage.output += u.output || 0;
		acc.usage.cacheRead += u.cacheRead || 0;
		acc.usage.cacheWrite += u.cacheWrite || 0;
		acc.usage.cost += u.cost?.total || 0;
		acc.usage.contextTokens = u.totalTokens || 0;
	}
	if (!acc.model && (msg as any).model) acc.model = (msg as any).model;
	if ((msg as any).stopReason) acc.stopReason = (msg as any).stopReason;
	if ((msg as any).errorMessage) acc.errorMessage = (msg as any).errorMessage;
	const activity = describeActivity(msg);
	if (activity) acc.lastActivity = activity;
	return { text: acc.lastActivity, usage: { ...acc.usage }, model: acc.model };
}

/** One-line description of the most recent assistant activity (text or tool call). */
function describeActivity(msg: Message): string {
	if (msg.role !== "assistant") return "";
	let lastText = "";
	let lastTool = "";
	for (const part of (msg as any).content ?? []) {
		if (part.type === "text" && part.text?.trim()) lastText = part.text.trim();
		else if (part.type === "toolCall") lastTool = summarizeToolCall(part.name, part.arguments ?? {});
	}
	const chosen = lastText || lastTool;
	return chosen.replace(/\s+/g, " ").trim();
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const short = (p: unknown) => {
		const s = String(p ?? "");
		return s.length > 48 ? `${s.slice(0, 48)}…` : s;
	};
	switch (name) {
		case "bash":
			return `$ ${short(args.command)}`;
		case "read":
			return `read ${short(args.path ?? args.file_path)}`;
		case "write":
			return `write ${short(args.path ?? args.file_path)}`;
		case "edit":
			return `edit ${short(args.path ?? args.file_path)}`;
		case "grep":
			return `grep ${short(args.pattern)}`;
		case "find":
			return `find ${short(args.pattern)}`;
		case "ls":
			return `ls ${short(args.path)}`;
		default:
			return `${name}`;
	}
}

async function writePromptToTempFile(filePath: string, prompt: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Explicit override (used by tests and unusual launch setups).
	const override = process.env.PI_TASKFLOW_PI_BIN;
	if (override) return { command: override, args };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// Only re-exec the current script if it actually looks like the pi CLI entry.
	const looksLikePi = currentScript ? /(?:^|[\\/])(?:cli|pi)\.(?:js|mjs|cjs)$/.test(currentScript) : false;
	if (currentScript && !isBunVirtualScript && looksLikePi && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Resolve the path to this extension's entry file, so a spawned subagent can be
 * launched with `--extension <path>` and register the ctx_* tools. Returns
 * undefined if it cannot be resolved (the subagent then simply runs without the
 * ctx tools — fail-open: context sharing degrades to "no sharing").
 */
export function ctxExtensionPath(): string | undefined {
	const override = process.env.PI_TASKFLOW_EXT_PATH;
	if (override) return override;
	try {
		const here = path.dirname(new URL(import.meta.url).pathname);
		const entry = path.join(here, "index.ts");
		if (fs.existsSync(entry)) return entry;
	} catch {
		/* fall through */
	}
	return undefined;
}

/**
 * Run a single subagent task. Resolves the agent from `agents` by name and
 * spawns an isolated pi process, returning structured output + usage.
 */
export async function runAgentTask(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: RunOptions,
	globalThinking?: string,
): Promise<RunResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			output: "",
			stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
			usage: emptyUsage(),
			errorMessage: `Unknown agent: ${agentName}`,
			stopReason: "error",
		};
	}

	const model = opts.model ?? agent.model;
	const thinking = opts.thinking ?? agent.thinking ?? globalThinking;
	const ctxEnabledEarly = Boolean(opts.ctxDir && opts.nodeId);
	let tools = opts.tools ?? agent.tools;
	// If the agent restricts tools to a whitelist, the ctx_* tools we register
	// would be filtered out by `--tools` even though they're registered. When
	// context sharing is on, extend the whitelist so the subagent can actually
	// call them. (No whitelist = all tools available = nothing to do.)
	if (ctxEnabledEarly && tools && tools.length > 0) {
		tools = [...new Set([...tools, ...CTX_TOOL_NAMES])];
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const acc = newAccumulator(model);
	const result: RunResult = {
		agent: agentName,
		task,
		exitCode: 0,
		output: "",
		stderr: "",
		usage: emptyUsage(),
		model,
	};

	try {
		const ctxEnabled = Boolean(opts.ctxDir && opts.nodeId);
		// Build the appended system prompt = the agent's own prompt PLUS, when the
		// Shared Context Tree is enabled for this phase, a guidance block that tells
		// the subagent the ctx_* tools exist and the discipline for using them.
		// Without this the model only sees terse tool descriptions and rarely uses
		// them proactively (capability != usage).
		const appendedPrompt = [agent.systemPrompt.trim(), ctxEnabled ? CTX_TOOLS_GUIDANCE : ""]
			.filter(Boolean)
			.join("\n\n");
		if (appendedPrompt) {
			// Allocate the temp dir + path BEFORE any fallible I/O so that if
			// writeFile throws, tmpPromptDir/tmpPromptPath are already set and
			// the finally block can clean up the directory (F-004).
			tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-taskflow-"));
			const safeName = agent.name.replace(/[^\w.-]+/g, "_");
			tmpPromptPath = path.join(tmpPromptDir, `prompt-${safeName}.md`);
			await writePromptToTempFile(tmpPromptPath, appendedPrompt);
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${task}`);

		// Shared Context Tree opt-in: load THIS extension into the subagent so it
		// can register the ctx_* tools, and pass the blackboard dir + node id via
		// env. `--extension` is the explicit, self-documenting fallback that does
		// not rely on the subagent auto-discovering user/project extensions in
		// `-p` mode. The env vars drive the dual-identity branch in index.ts.
		const ctxEnv: Record<string, string> = {};
		if (opts.ctxDir && opts.nodeId) {
			const selfPath = ctxExtensionPath();
			if (selfPath) args.push("--extension", selfPath);
			ctxEnv.PI_TASKFLOW_CTX_DIR = opts.ctxDir;
			ctxEnv.PI_TASKFLOW_NODE_ID = opts.nodeId;
		}

		let wasAborted = false;
		let idleTimedOut = false;
		let killedBySignal: string | undefined;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...ctxEnv },
			});
			if (proc.pid) activeChildren.add(proc.pid);
			let buffer = "";

			// Idle watchdog: a subagent that goes silent on stdout for too long is
			// treated as wedged and killed, so one stalled child cannot hang the
			// whole taskflow forever. The timer is reset on every stdout chunk and
			// torn down on close/error.
			const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			const clearTimers = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
			};
			const hardKill = () => {
				proc.kill("SIGTERM");
				forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
				forceKillTimer.unref();
			};
			const armIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (idleMs <= 0) return; // disabled
				idleTimer = setTimeout(() => {
					idleTimedOut = true;
					hardKill();
				}, idleMs);
				idleTimer.unref();
			};
			armIdle();

			const processLine = (line: string) => {
				const live = foldEventLine(acc, line);
				if (live && opts.onLive) opts.onLive(live);
			};

			proc.stdout.on("data", (data) => {
				armIdle(); // progress observed — reset the idle watchdog
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			// Cap prevents OOM from verbose tool output (e.g., npm install). 64 KB is
			// generous for error diagnosis while preventing memory exhaustion.
			const STDERR_MAX_LEN = 64 * 1024;
			let stderrCapped = false;
			proc.stderr.on("data", (data) => {
				if (!stderrCapped) {
					result.stderr += data.toString();
					if (result.stderr.length >= STDERR_MAX_LEN) {
						result.stderr = result.stderr.slice(0, STDERR_MAX_LEN) + "\n[...stderr truncated at 64KB]";
						stderrCapped = true;
					}
				}
			});
			proc.on("close", (code, signal) => {
				if (proc.pid) activeChildren.delete(proc.pid);
				clearTimers();
				if (buffer.trim()) processLine(buffer);
				if (code === null && signal) killedBySignal = signal;
				resolve(code ?? 0);
			});
			proc.on("error", (err) => {
				clearTimers();
				if (!result.stderr) result.stderr = err.message;
				if (!result.errorMessage) result.errorMessage = err.message;
				resolve(1);
			});

			if (opts.signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					// Force-kill fallback. proc.kill("SIGKILL") is idempotent if
					// the process already exited, and `proc.killed` is set true
					// synchronously by the SIGTERM above — so the previous
					// `if (!proc.killed)` guard would skip SIGKILL entirely,
					// hanging forever on a child that ignores SIGTERM.
					// .unref() keeps the timer from holding the event loop open
					// after the process is gone.
					const forceKill = setTimeout(() => proc.kill("SIGKILL"), 5000);
					forceKill.unref();
				};
				if (opts.signal.aborted) kill();
				else opts.signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.usage = acc.usage;
		result.model = acc.model;
		result.stopReason = acc.stopReason;
		result.errorMessage = acc.errorMessage;
		result.output = getFinalOutput(acc.messages);
		// M-6: surface truncation when the message cap was hit so downstream
		// phases and the user know output was cut short.
		if (acc.truncated) {
			result.output += "\n\n[...output truncated after 500 messages]";
		}
		// Signal kill detection: process exited 0 but was killed by a signal
		// (e.g. OOM killer, cgroup limit). Treat as failure so the runtime's
		// retry/fail handling doesn't silently accept a truncated result.
		if (exitCode === 0 && killedBySignal && !idleTimedOut && !wasAborted) {
			result.exitCode = 1;
			result.stopReason = "error";
			result.errorMessage = `Subagent killed by signal ${killedBySignal}`;
		}
		if (idleTimedOut) {
			// Distinct, actionable signal: the child was killed for being idle, not
			// a user abort. stopReason "error" keeps it in the failed bucket so the
			// runtime's retry/fail handling treats it as a real failure.
			result.stopReason = "error";
			result.idleTimeout = true;
			result.errorMessage = `Subagent stalled: no output for ${Math.round((opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 1000)}s (idle timeout) — killed`;
		} else if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		}
		// On failure, build a short, structured errorMessage + a placeholder
		// output. We deliberately do NOT copy the raw errorMessage into
		// `output`: upstream providers (e.g. a Cloudflare challenge page) can
		// surface huge HTML/JSON in errorMessage, and that garbage would
		// otherwise flow into downstream phase interpolations.
		// Sanitization must run whenever the run failed, even if some output
		// was already emitted (e.g. crash mid-stream with a partial result):
		// an unsanitized errorMessage would still leak into PhaseState and
		// downstream interpolation contexts. (F-013)
		if (isFailed(result)) {
			if (!result.output) {
				result.output = TRANSPORT_ERROR_PLACEHOLDER;
				if (!result.errorMessage) {
					result.errorMessage = result.stderr || `Subagent exited with code ${result.exitCode} (stopReason: ${result.stopReason ?? "unknown"})`;
				}
			}
			if (result.errorMessage) {
				result.errorMessage = sanitizeErrorMessage(result.errorMessage);
			}
		}
		return result;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * The pi host's `SubagentRunner` implementation: spawns an isolated
 * `pi --mode json -p` process per task via `runAgentTask`. This is the object
 * the engine receives when running under pi; a Codex host ships its own
 * `codexSubagentRunner` against the same `SubagentRunner` contract.
 */
export const piSubagentRunner: SubagentRunner<AgentConfig> = {
	runTask: runAgentTask,
};

/** Run an array of items through `fn` with a bounded concurrency pool. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
