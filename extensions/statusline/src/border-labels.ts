/**
 * Pure border-label builders for the model-line editor. Extracted from
 * ModelLineEditor so they can be unit-tested without pi's runtime module
 * resolution (this file must not import pi packages).
 */
import { BADGE_CAP_WIDTH } from "./badge.ts";
import { formatTokens, stripAnsi } from "./format.ts";
import { formatModelStatus, type ModelStatusInfo } from "./status-mode.ts";

export interface TokenStats {
	input: number;
	output: number;
}

/**
 * Visible column count for our label alphabet (ASCII, box-drawing, Nerd
 * Font PUA). Counts Unicode code points — not UTF-16 units, so astral-plane
 * icons (surrogate pairs) are not overcounted.
 */
function displayLength(s: string): number {
	return [...stripAnsi(s)].length;
}

/**
 * Top border segments: mode on the left, token stats on the right.
 *
 *   ──Auto──────────────── ↑284k ↓37.3k ──
 *   ^^^    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *   pre    post              (mode = "Auto")
 *
 * `mode` is the plain label; the decorator adds two powerline caps, so
 * post is sized against label width + BADGE_CAP_WIDTH.
 *
 * Returned as segments so the caller can color the border runs and the
 * mode badge independently — a fg/bg reset inside a single colored line
 * would cut the border color for everything after the badge.
 * Returns undefined when there is nothing to splice (keep the plain
 * border). If both sides cannot fit, the mode (safety signal) wins and
 * stats are dropped.
 */
export interface TopBorderSegments {
	/** Border run before the badge ("──"); empty when no mode. */
	pre: string;
	/** Badge text ("Auto"), plain — caller decorates. Empty when no mode. */
	mode: string;
	/** Border run after the badge, including right-aligned stats. */
	post: string;
}

export function buildTopBorder(
	width: number,
	mode: string | undefined,
	stats: TokenStats | undefined,
): TopBorderSegments | undefined {
	const modeSegment = mode ? `${mode}` : "";
	const modeWidth =
		modeSegment.length > 0 ? displayLength(modeSegment) + BADGE_CAP_WIDTH : 0;
	const pre = modeWidth > 0 ? "──" : "";
	const leftWidth = pre.length + modeWidth;
	const right =
		stats && (stats.input > 0 || stats.output > 0)
			? ` ↑${formatTokens(stats.input)} ↓${formatTokens(stats.output)} ──`
			: "";
	if (leftWidth === 0 && right.length === 0) return undefined;
	if (leftWidth + displayLength(right) < width) {
		return {
			pre,
			mode: modeSegment,
			post: "─".repeat(width - leftWidth - displayLength(right)) + right,
		};
	}
	if (leftWidth > 0 && leftWidth <= width) {
		return { pre, mode: modeSegment, post: "─".repeat(width - leftWidth) };
	}
	// Mode wider than the terminal (unrealistic for Auto/Default) or stats
	// alone not fitting: keep the plain border.
	return undefined;
}

export interface BottomBorderSegments {
	/** Border run before the pill ("──"). */
	pre: string;
	/** Powerline pill (may carry ANSI); caller must not wrap in borderColor. */
	pill: string;
	/** Border run after the pill, already filled to width. */
	post: string;
}

/**
 * Bottom border: model identity on the left.
 *
 *   ──modeleffort─────────────
 *
 * Pill sits flush against the left rule, matching the top-border mode badge.
 * Returned as segments so the caller can color the border runs independently —
 * the pill's own fg/bg resets would otherwise cut the border color.
 * Returns undefined when the label does not fit.
 */
export function buildBottomBorder(
	width: number,
	info: ModelStatusInfo,
	modelAnsi?: string,
	effortAnsi?: string,
): BottomBorderSegments | undefined {
	const pre = "──";
	const pill = formatModelStatus(info, modelAnsi, effortAnsi);
	const leftWidth = displayLength(pre) + displayLength(pill);
	if (leftWidth >= width) return undefined;
	return { pre, pill, post: "─".repeat(width - leftWidth) };
}