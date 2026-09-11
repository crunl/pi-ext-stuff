/**
 * Pure border-label builders for the model-line editor. Extracted from
 * ModelLineEditor so they can be unit-tested without pi's runtime module
 * resolution (this file must not import pi packages).
 */
import { BADGE_CAP_WIDTH } from "./badge.ts";
import { formatTokens } from "./format.ts";
import { formatModelStatus, type ModelStatusInfo } from "./status-mode.ts";

export interface TokenStats {
	input: number;
	output: number;
}

/**
 * Top border segments: mode on the left, token stats on the right.
 *
 *   ──Auto──────────────── ↑284k ↓37.3k ──
 *   ^^^    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *   pre    post              (mode = "Auto")
 *
 * `mode` is the plain label; the decorator adds two powerline
 * half-circle caps around it, so post is sized against
 * label.length + BADGE_CAP_WIDTH.
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
	/** Badge text ("Auto"), plain — caller decorates with caps. Empty when no mode. */
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
	// Decorator adds half-circle caps on each side; reserve their columns.
	const modeWidth =
		modeSegment.length > 0 ? modeSegment.length + BADGE_CAP_WIDTH : 0;
	const pre = modeWidth > 0 ? "──" : "";
	const leftWidth = pre.length + modeWidth;
	const right =
		stats && (stats.input > 0 || stats.output > 0)
			? ` ↑${formatTokens(stats.input)} ↓${formatTokens(stats.output)} ──`
			: "";
	if (leftWidth === 0 && right.length === 0) return undefined;
	if (leftWidth + right.length < width) {
		return {
			pre,
			mode: modeSegment,
			post: "─".repeat(width - leftWidth - right.length) + right,
		};
	}
	if (leftWidth > 0 && leftWidth <= width) {
		return { pre, mode: modeSegment, post: "─".repeat(width - leftWidth) };
	}
	// Mode wider than the terminal (unrealistic for Auto/Default) or stats
	// alone not fitting: keep the plain border.
	return undefined;
}

/**
 * Bottom border: model identity on the left.
 *
 *   ── model • effort ─────────────────────
 *
 * Returns undefined when the label does not fit.
 */
export function buildBottomBorder(
	width: number,
	info: ModelStatusInfo,
): string | undefined {
	const decorated = `── ${formatModelStatus(info)} `;
	if (decorated.length >= width) return undefined;
	return decorated + "─".repeat(width - decorated.length);
}
