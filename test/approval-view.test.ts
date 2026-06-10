import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalViewComponent, type ApprovalChoice } from "../extensions/approval-view.ts";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mk(upstream?: string, rows = 24) {
	let result: ApprovalChoice | undefined;
	const view = new ApprovalViewComponent(
		theme,
		{ title: "Taskflow approval — flow/checkpoint", message: "Approve the plan?", upstream },
		(c) => {
			result = c;
		},
		() => rows,
	);
	return { view, result: () => result };
}

test("approval-view: renders title, message and hints", () => {
	const { view } = mk("a plan");
	const out = view.render(80).join("\n");
	assert.match(out, /Taskflow approval — flow\/checkpoint/);
	assert.match(out, /Approve the plan\?/);
	assert.match(out, /a\/Enter approve · e edit · r\/Esc reject/);
});

test("approval-view: long upstream is windowed with scroll indicator", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view } = mk(upstream, 24); // 24 rows → 12 visible body lines
	const out = view.render(80);
	const text = out.join("\n");
	assert.match(text, /line-0/, "top of content visible initially");
	assert.doesNotMatch(text, /line-99\b/, "bottom not visible before scrolling");
	assert.match(text, /↓\d+ more/, "scroll indicator shows hidden lines below");
	assert.match(text, /scroll/, "hint mentions scrolling when content overflows");
});

test("approval-view: down/pageDown/end scroll the viewport", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view } = mk(upstream, 24);
	view.render(80); // establish wrapped body cache
	view.handleInput("\u001b[B"); // down arrow
	let text = view.render(80).join("\n");
	assert.doesNotMatch(text, /line-0\n/, "first line scrolled out");
	assert.match(text, /↑1 more/, "indicator counts lines above");

	view.handleInput("\u001b[F"); // end
	text = view.render(80).join("\n");
	assert.match(text, /line-99/, "End jumps to the bottom");

	view.handleInput("\u001b[H"); // home
	text = view.render(80).join("\n");
	assert.match(text, /line-0/, "Home jumps back to the top");
});

test("approval-view: decisions — enter approves, e edits, esc rejects", () => {
	{
		const { view, result } = mk("x");
		view.handleInput("\r");
		assert.equal(result(), "approve");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("e");
		assert.equal(result(), "edit");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("\u001b"); // escape
		assert.equal(result(), "reject");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("a");
		assert.equal(result(), "approve");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("r");
		assert.equal(result(), "reject");
	}
});

test("approval-view: no upstream → no scroll hint, no body separator", () => {
	const { view } = mk(undefined);
	const text = view.render(80).join("\n");
	assert.doesNotMatch(text, /more/, "no scroll indicator without body");
	assert.doesNotMatch(text, /PgUp/, "no scroll hint without overflow");
});

test("approval-view: short upstream fits without scroll indicator", () => {
	const { view } = mk("only\ntwo lines here", 30);
	const text = view.render(80).join("\n");
	assert.match(text, /only/);
	assert.match(text, /two lines here/);
	assert.doesNotMatch(text, /more/, "no scroll indicator when content fits");
});

test("approval-view: getRows failure falls back to default height", () => {
	let result: ApprovalChoice | undefined;
	const view = new ApprovalViewComponent(
		theme,
		{ title: "t", message: "m", upstream: "body" },
		(c) => {
			result = c;
		},
		() => {
			throw new Error("no tty");
		},
	);
	const text = view.render(80).join("\n");
	assert.match(text, /body/, "renders despite getRows throwing");
	view.handleInput("\r");
	assert.equal(result, "approve");
});

test("approval-view: invalidate clears cache and re-wraps on width change", () => {
	const upstream = "x".repeat(200);
	const { view } = mk(upstream, 30);
	const wide = view.render(120);
	view.invalidate();
	const narrow = view.render(40);
	assert.ok(narrow.length >= wide.length, "narrower width wraps into more lines");
});
