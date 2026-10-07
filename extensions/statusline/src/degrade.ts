/**
 * Footer degradation ladder — the heart of the width-adaptive footer.
 *
 * Two independent ladders, each a strictly-narrowing sequence of forms:
 *
 *   LEFT  (context: "where am I")   pill+icons → plain `|` → drop branch →
 *                                   drop effort → drop folder → model only
 *   RIGHT (telemetry: "how full")   CH+meter10+tokens → drop CH → meter5 →
 *                                   drop meter → tokens→pct → pct→icon → gone
 *
 * They are interleaved by SHED_MOVES into one global staircase. Because each
 * ladder is monotone and the staircase only ever advances one coordinate at a
 * time, `dedupeNarrowing` yields a strictly-decreasing width sequence — so
 * `selectFitting` picks a level that is a monotone function of the available
 * width. Wider terminal ⇒ never less content ⇒ no per-frame oscillation.
 *
 * Design rulings baked in here (see the footer degradation discussion):
 *  - RIGHT is one fact (context usage) in several encodings, not competing
 *    atoms. Degrade = shed encodings: graphic meter (redundant, but the only
 *    *compressible* one, so it buffers first) → absolute tokens (needs mental
 *    math) → the percentage (the threshold pi actually compacts on) last.
 *  - LEFT sheds its powerline chrome (caps/arrows/icons) before it sheds any
 *    *text*: plain colored `|`-joined labels keep every name while costing
 *    far fewer columns than the pill. Segment text is only ever truncated as
 *    the very last resort, and only inside the sole surviving segment — so the
 *    pill is never sliced mid-body (which would drop its right cap and leave
 *    an open color block).
 *
 * Pure: no Pi imports. `measure` (pi-tui visibleWidth) and `fg` (theme.fg) are
 * injected, so the whole ladder is unit-testable under bare `node --test`.
 */

import { formatTokens, ICONS, isHiddenExtensionStatus, meterCells, sanitizeStatusText } from "./format.ts";
import {
	coloredSpan,
	dedupeNarrowing,
	EMPTY_SPAN,
	type Measure,
	joinSpans,
	paint,
	selectFitting,
	type Span,
	span,
} from "./layout.ts";
import { truecolorFg } from "./palette.ts";
import { powerlineChain, syncPermissionsMode } from "./status-mode.ts";

/** A colorizer: wrap `text` in the theme color named `color`. */
export type Fg = (color: string, text: string) => string;

export type LeftKey = "model" | "effort" | "folder" | "branch";

export interface LeftSeg {
	key: LeftKey;
	/** Plain label text (model id, effort level, folder leaf, branch name). */
	text: string;
	hex: `#${string}`;
	icon: string;
}

/** Left segments in display order; caller omits any that are absent. */
export interface LeftInput {
	segments: readonly LeftSeg[];
}

export interface RightInput {
	/** Cache hit rate %, or undefined when the CH block should not render. */
	cacheRate: number | undefined;
	/** Context usage, or undefined when there is none to show. */
	usage:
		| { percent: number | null; tokens: number | null; window: number }
		| undefined;
}

export interface FooterData {
	left: LeftInput;
	right: RightInput;
}

const METER_CELLS = 10;
const METER_CELLS_COMPACT = 5;

/**
 * Global shed staircase as a move pattern: "R" advances the right ladder one
 * level, "L" the left. Read as: shed the right side's redundant encodings
 * first (CH, then meter 10→5, then meter entirely), then start giving up left
 * chrome/segments, interleaving the last right levels (tokens→pct→icon) with
 * the last left segments. Order encodes scarcity: folder/branch are trivially
 * recoverable (pwd, git), the "context nearly full" signal exists nowhere else.
 */
export const SHED_MOVES = ["R", "R", "R", "L", "L", "R", "L", "L", "R", "R"] as const;

// ---------------------------------------------------------------- left forms

/**
 * Build the left ladder, richest first:
 *   [0] powerline pill with icons (all present segments)
 *   [1] plain `|`-joined colored labels, no icons/caps (all segments)
 *   [2..] plain, dropping branch → effort → folder in turn (model survives)
 * Duplicate widths (e.g. branch already absent) are collapsed downstream.
 */
export function buildLeftForms(input: LeftInput, measure: Measure, fg: Fg): Span[] {
	const segs = input.segments;
	if (segs.length === 0) return [EMPTY_SPAN];

	const forms: Span[] = [];

	// [0] pill — the only form that pays for caps/arrows/icon padding.
	const chain = powerlineChain(
		segs.map((s) => ({ text: `${s.icon} ${s.text}`, ansi: truecolorFg(s.hex) })),
	);
	forms.push(coloredSpan(chain, measure(chain)));

	// [1..] plain `|`-joined labels: color survives as fg, chrome does not.
	const pipe = coloredSpan(fg("dim", " | "), measure(" | "));
	const plainSeg = (s: LeftSeg): Span =>
		paint(span(s.text, measure), (t) => `${truecolorFg(s.hex)}${t}\x1b[39m`);

	const dropOrder: readonly LeftKey[] = ["branch", "effort", "folder"];
	let present = segs.slice();
	forms.push(joinSpans(present.map(plainSeg), pipe));
	for (const key of dropOrder) {
		const next = present.filter((s) => s.key !== key);
		if (next.length === present.length) continue; // key absent — no-op
		present = next;
		forms.push(joinSpans(present.map(plainSeg), pipe));
	}
	return forms;
}

// --------------------------------------------------------------- right forms

function meterColorFor(percent: number | null): string {
	// null percent = unknown (e.g. right after a compaction). Never paint an
	// unknown state green — that reads as "plenty of room". Use dim.
	if (percent === null) return "dim";
	return percent >= 75 ? "error" : percent >= 50 ? "warning" : "success";
}

/**
 * Build the right ladder, richest first (7 canonical levels):
 *   [0] CH  +  gauge meter10 tokens
 *   [1]        gauge meter10 tokens        (drop CH)
 *   [2]        gauge meter5  tokens        (meter 10→5)
 *   [3]        gauge         tokens        (drop meter)
 *   [4]        gauge         pct           (tokens → percentage)
 *   [5]        gauge                       (drop pct, keep threshold-colored icon)
 *   [6]                                    (right empty)
 * Absent data (no cache / no usage) collapses levels; dedupe removes the ties.
 */
export function buildRightForms(input: RightInput, measure: Measure, fg: Fg): Span[] {
	const gap = span("  ", measure); // 2-col gap between CH block and usage block
	const sp = span(" ", measure); // 1-col gap inside a block

	// --- cache block (optional) ---
	let cacheBlock: Span = EMPTY_SPAN;
	if (input.cacheRate !== undefined) {
		const chText = `CH${input.cacheRate.toFixed(1)}%`;
		cacheBlock = joinSpans(
			[
				paint(span(ICONS.cache, measure), (t) => fg("accent", t)),
				paint(span(chText, measure), (t) => fg("dim", t)),
			],
			sp,
		);
	}

	// --- usage sub-blocks (all optional on usage presence) ---
	const u = input.usage;
	let meter10 = EMPTY_SPAN;
	let meter5 = EMPTY_SPAN;
	let tokensBlk = EMPTY_SPAN;
	let pctBlk = EMPTY_SPAN;
	let iconBlk = EMPTY_SPAN;

	if (u) {
		const color = meterColorFor(u.percent);
		iconBlk = paint(span(ICONS.gauge, measure), (t) => fg("accent", t));

		// meter only when percent is known (a null percent has no fill count)
		if (u.percent !== null) {
			const build = (cells: number): Span => {
				const filled = meterCells(u.percent as number, cells);
				const fillStr = "█".repeat(filled);
				const restStr = "░".repeat(cells - filled);
				const fill = filled > 0 ? paint(span(fillStr, measure), (t) => fg(color, t)) : EMPTY_SPAN;
				const rest = filled < cells ? paint(span(restStr, measure), (t) => fg("dim", t)) : EMPTY_SPAN;
				return joinSpans([fill, rest], EMPTY_SPAN);
			};
			meter10 = build(METER_CELLS);
			meter5 = build(METER_CELLS_COMPACT);
		}

		const tokText =
			u.tokens !== null
				? `${formatTokens(u.tokens)}/${formatTokens(u.window)}`
				: `?/${formatTokens(u.window)}`;
		tokensBlk = paint(span(tokText, measure), (t) => fg(color, t));

		const pctText = u.percent !== null ? `${Math.round(u.percent)}%` : "?";
		pctBlk = paint(span(pctText, measure), (t) => fg(color, t));
	}

	// Compose usage levels richest → leanest.
	const usageLevels: Span[] = [
		joinSpans([iconBlk, meter10, tokensBlk], sp), // meter10 + tokens
		joinSpans([iconBlk, meter5, tokensBlk], sp), // meter5 + tokens
		joinSpans([iconBlk, tokensBlk], sp), // tokens
		joinSpans([iconBlk, pctBlk], sp), // pct
		iconBlk, // icon only
		EMPTY_SPAN, // gone
	];

	// Right ladder: [cache + usage0], then usage levels 0..5.
	return [
		joinSpans([cacheBlock, usageLevels[0]!], gap),
		usageLevels[0]!,
		usageLevels[1]!,
		usageLevels[2]!,
		usageLevels[3]!,
		usageLevels[4]!,
		usageLevels[5]!,
	];
}

// ------------------------------------------------------------- interleaving

export interface FooterCandidate {
	readonly left: Span;
	readonly right: Span;
}

/**
 * Walk SHED_MOVES over the two ladders from (0,0), advancing one coordinate
 * per move (capped at each ladder's end), emitting a candidate at every state.
 * `dedupeNarrowing` then drops any step that is not strictly narrower than its
 * predecessor — which is what guarantees the monotone-width contract that
 * makes selectFitting oscillation-free.
 */
export function buildFooterCandidates(
	leftForms: readonly Span[],
	rightForms: readonly Span[],
): FooterCandidate[] {
	let l = 0;
	let r = 0;
	const out: FooterCandidate[] = [
		{ left: leftForms[0] ?? EMPTY_SPAN, right: rightForms[0] ?? EMPTY_SPAN },
	];
	for (const move of SHED_MOVES) {
		if (move === "L") l = Math.min(l + 1, leftForms.length - 1);
		else r = Math.min(r + 1, rightForms.length - 1);
		out.push({
			left: leftForms[l] ?? EMPTY_SPAN,
			right: rightForms[r] ?? EMPTY_SPAN,
		});
	}
	return dedupeNarrowing(out);
}

/** Everything needed to lay out and render, minus the Pi runtime. */
export interface FooterLayoutDeps {
	measure: Measure;
	fg: Fg;
	data: FooterData;
}

/** Build the full candidate staircase from live footer data. */
export function buildCandidates(deps: FooterLayoutDeps): FooterCandidate[] {
	return buildFooterCandidates(
		buildLeftForms(deps.data.left, deps.measure, deps.fg),
		buildRightForms(deps.data.right, deps.measure, deps.fg),
	);
}

// ------------------------------------------------------------- full render

/** Injected truncator (production: pi-tui `truncateToWidth`). */
export type Truncate = (text: string, width: number, suffix?: string) => string;

export interface RenderFooterInput {
	/** Full terminal width in columns. */
	width: number;
	/** Left gutter width from settings.outputPad (0 or 1). */
	pad: number;
	left: LeftInput;
	right: RightInput;
	/** Raw extension statuses (setStatus key → text), pre-filter. */
	statuses: ReadonlyMap<string, string>;
}

export interface RenderFooterDeps {
	measure: Measure;
	truncate: Truncate;
	fg: Fg;
	/** Minimum columns kept between the left and right sides. */
	minPadding?: number;
}

/**
 * Lay out a chosen candidate within innerWidth: left, padding, right-aligned
 * right side. When it does not fit even at the leanest (fits === false), the
 * caller truncates the left span — safe because the leanest left form is a
 * single plain segment, so truncation lands inside that segment's text and
 * never across a powerline cap.
 */
function composeLine(
	cand: FooterCandidate,
	innerWidth: number,
	fits: boolean,
	deps: RenderFooterDeps,
): Span {
	if (!fits) {
		const truncated = deps.truncate(cand.left.text, innerWidth, deps.fg("dim", "…"));
		return { text: truncated, width: deps.measure(truncated) };
	}
	if (cand.right.width === 0) return cand.left;
	const padCount = Math.max(0, innerWidth - cand.left.width - cand.right.width);
	const padStr = " ".repeat(padCount);
	return {
		text: cand.left.text + padStr + cand.right.text,
		width: cand.left.width + padCount + cand.right.width,
	};
}

/**
 * Render the footer to its final string lines. This is the single seam that
 * owns the pi-tui width invariant: every returned line is clamped to `width`.
 * Pure and injectable, so the fuzz test can assert `visibleWidth(line) <= width`
 * across the whole content matrix without a Pi runtime.
 */
export function renderFooterLines(
	input: RenderFooterInput,
	deps: RenderFooterDeps,
): string[] {
	const measure = deps.measure;
	const minPadding = deps.minPadding ?? 2;
	const candidates = buildCandidates({
		measure,
		fg: deps.fg,
		data: { left: input.left, right: input.right },
	});

	const pad = input.pad;
	const gutter = " ".repeat(pad);
	const innerWidth = Math.max(0, input.width - pad * 2);

	const chosen = selectFitting(candidates, innerWidth, minPadding);
	const cand = candidates[chosen >= 0 ? chosen : candidates.length - 1]!;
	const line = composeLine(cand, innerWidth, chosen >= 0, deps);

	// Belt-and-suspenders: the final line must never exceed `width` (pi-tui
	// throws and stops the TUI otherwise). Only bites when width < pad.
	const firstLine = deps.truncate(gutter + line.text, input.width);

	const lines = [firstLine];

	// Line 2: other extensions' statuses, pi-safety stripped, pi-lens hidden.
	const visible = syncPermissionsMode(input.statuses).filter(
		([key]) => !isHiddenExtensionStatus(key),
	);
	if (visible.length > 0) {
		const merged = visible
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		lines.push(deps.truncate(gutter + merged, input.width));
	}

	return lines;
}
