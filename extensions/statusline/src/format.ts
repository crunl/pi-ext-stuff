/**
 * Pure formatting helpers for the statusline extension.
 * No ctx / tui dependencies — easy to test and reason about.
 */

/** Compact token count: 999 -> "999", 12300 -> "12.3k", 1500000 -> "1.5M" */
export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) {
		const k = count / 1000;
		return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
	}
	const m = count / 1_000_000;
	return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Compose a single line: left text + padding + right text (right-aligned).
 * If both don't fit, right side is truncated first; left survives.
 * `leftWidth`/`rightWidth` are the *visible* widths (caller computes, since
 * the strings may contain ANSI color codes).
 */
export function alignLine(
	left: string,
	leftWidth: number,
	right: string,
	rightWidth: number,
	width: number,
	minPadding = 2,
): { line: string; rightFits: boolean } {
	if (leftWidth + minPadding + rightWidth <= width) {
		const pad = " ".repeat(width - leftWidth - rightWidth);
		return { line: left + pad + right, rightFits: true };
	}
	return { line: left, rightFits: false };
}

/** Shorten a cwd for display: replace home dir with ~. */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

/** Nerd font icons — codepoints extracted from the reference opencode plugin. */
export const ICONS = {
	folder: "\u{F024B}", // 📁 nf-md-folder
	branch: "\u{F0641}", // -like nf-md-source_branch
	gauge: "\uF49B", // gauge icon used before the usage meter
	cache: "\uF1C0", // nf-fa-database (cache blocks)
	model: "\u{F035B}", // nf-md-memory — editor bottom border model
	effort: "\u{F0875}", // nf-md-gauge_low — editor bottom border effort
} as const;

/**
 * Block meter cells: how many of `cells` blocks are filled for `percent`.
 * ceil(percent/10) semantics, same as the opencode reference (cells=10).
 */
export function meterCells(percent: number, cells = 10): number {
	const clamped = Math.max(0, Math.min(100, percent));
	return Math.ceil((clamped / 100) * cells);
}
