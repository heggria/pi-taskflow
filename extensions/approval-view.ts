/**
 * Scrollable approval view for `approval` phases (ctx.ui.custom).
 *
 * Replaces the old notify-snippet + ctx.ui.select flow: the full upstream
 * output (e.g. a plan) is shown in a scrollable viewport so long content
 * can be reviewed before deciding.
 *
 * Keys: ↑↓ scroll · PgUp/PgDn page · Home/End jump · a/Enter approve ·
 *       e edit (guidance) · r/Esc reject.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type ApprovalChoice = "approve" | "reject" | "edit";

export interface ApprovalViewOptions {
	/** Header title, e.g. "Taskflow approval — flow/phase". */
	title: string;
	/** Interpolated approval prompt. */
	message: string;
	/** Full upstream phase output (the content being approved). */
	upstream?: string;
}

const FALLBACK_ROWS = 24;
/** Rows reserved for header, message, hints and padding. */
const CHROME_ROWS = 12;

export class ApprovalViewComponent {
	private theme: Theme;
	private opts: ApprovalViewOptions;
	private onDone: (choice: ApprovalChoice) => void;
	private getRows: () => number;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedBody?: string[];

	constructor(
		theme: Theme,
		opts: ApprovalViewOptions,
		onDone: (choice: ApprovalChoice) => void,
		getRows?: () => number,
	) {
		this.theme = theme;
		this.opts = opts;
		this.onDone = onDone;
		this.getRows = getRows ?? (() => FALLBACK_ROWS);
	}

	/** Visible body height — adapts to the terminal, clamped to a sane range. */
	private maxVisible(): number {
		let rows = FALLBACK_ROWS;
		try {
			rows = this.getRows() || FALLBACK_ROWS;
		} catch {
			// fall back to default
		}
		return Math.max(5, Math.min(rows - CHROME_ROWS, 40));
	}

	/** Wrap the upstream text to the viewport width (cached per width). */
	private bodyLines(width: number): string[] {
		if (this.cachedBody && this.cachedWidth === width) return this.cachedBody;
		const w = Math.max(20, width - 4);
		const out: string[] = [];
		const upstream = (this.opts.upstream ?? "").replace(/\r\n/g, "\n").trimEnd();
		if (upstream) {
			for (const raw of upstream.split("\n")) {
				if (!raw.trim()) {
					out.push("");
					continue;
				}
				for (const l of wrapTextWithAnsi(raw, w)) out.push(l);
			}
		}
		this.cachedWidth = width;
		this.cachedBody = out;
		this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset(out.length));
		return out;
	}

	private maxOffset(totalLines: number): number {
		return Math.max(0, totalLines - this.maxVisible());
	}

	handleInput(data: string): void {
		// Decisions
		if (matchesKey(data, "return") || data === "a" || data === "y") {
			this.onDone("approve");
			return;
		}
		if (data === "e") {
			this.onDone("edit");
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "r" || data === "n") {
			this.onDone("reject");
			return;
		}
		// Scrolling (only meaningful when a body exists)
		const total = this.cachedBody?.length ?? 0;
		const page = this.maxVisible();
		const cap = this.maxOffset(total);
		if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset = Math.min(cap, this.scrollOffset + 1);
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - page);
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d") || matchesKey(data, "space")) {
			this.scrollOffset = Math.min(cap, this.scrollOffset + page);
		} else if (matchesKey(data, "home") || data === "g") {
			this.scrollOffset = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.scrollOffset = cap;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [""];

		// Header
		const label = ` ${this.opts.title} `;
		const header =
			th.fg("borderMuted", "─".repeat(3)) +
			th.fg("accent", label) +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - label.length)));
		lines.push(truncateToWidth(header, width));
		lines.push("");

		// Approval prompt
		for (const raw of this.opts.message.split("\n")) {
			for (const l of wrapTextWithAnsi(raw, Math.max(20, width - 4))) {
				lines.push(truncateToWidth(`  ${th.fg("text", l)}`, width));
			}
		}

		// Scrollable upstream body
		const body = this.bodyLines(width);
		if (body.length > 0) {
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`, width));
			const visible = this.maxVisible();
			const cap = this.maxOffset(body.length);
			const slice = body.slice(this.scrollOffset, this.scrollOffset + visible);
			for (const l of slice) {
				lines.push(truncateToWidth(`  ${l}`, width));
			}
			if (cap > 0) {
				const above = this.scrollOffset;
				const below = Math.max(0, body.length - visible - this.scrollOffset);
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `↑${above} more · ↓${below} more (${body.length} lines)`)}`,
						width,
					),
				);
			}
		}

		// Key hints
		lines.push("");
		const scrollHint = this.maxOffset(body.length) > 0 ? "↑↓/PgUp/PgDn scroll · " : "";
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", `${scrollHint}a/Enter approve · e edit · r/Esc reject`)}`,
				width,
			),
		);
		lines.push("");
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedBody = undefined;
	}
}
