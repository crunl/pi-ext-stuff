/**
 * Pure formatting helpers for the statusline extension.
 * No ctx / tui dependencies — easy to test and reason about.
 *
 * ANSI handling note: nothing here strips SGR anymore. Widths are measured by
 * the injected pi-tui `visibleWidth` (see layout.ts), which ignores SGR itself.
 */

/** Compact token count: 999 -> "999", 12300 -> "12.3k", 1500000 -> "1.5M" */
export function formatTokens(count: number): string {
	// Guard non-finite inputs: NaN/Infinity would render as "NaNM"/"InfinityM"
	// (up to 9 columns) and silently break every width prediction downstream.
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) {
		const k = count / 1000;
		return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
	}
	const m = count / 1_000_000;
	return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Neutralize a third-party extension status before it enters the footer.
 * pi-tui measures a tab as 3 columns but a terminal may expand it to 8, which
 * is the one known path to an overflowing (=> crash) line; newlines would split
 * the single footer line. Fold tabs to spaces and collapse runs, mirroring the
 * built-in footer's sanitizeStatusText.
 */
export function sanitizeStatusText(text: string): string {
	return text.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * Shorten a cwd for display: only the leaf folder name (e.g.
 * `~/workspace/tsnjs/pi-ext-stuff` → `pi-ext-stuff`). The home directory
 * itself stays `~` so the root case is not shown as a bare username.
 */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (home && cwd === home) {
		return "~";
	}
	const name = cwd.split(/[\\/]/).filter(Boolean).pop();
	return name ?? cwd;
}

/** Nerd font icons — codepoints extracted from the reference opencode plugin. */
export const ICONS = {
	folder: "\u{F024B}", // 📁 nf-md-folder
	branch: "\u{F0641}", // -like nf-md-source_branch
	gauge: "\uF49B", // gauge icon used before the usage meter
	cache: "\uF1C0", // nf-fa-database (cache blocks)
	model: "\u{F035B}", // nf-md-memory — editor bottom border model
	effort: "\u{F09D1}", //  — thinking / effort segment
} as const;

/**
 * Extension statuses hidden from the footer second line, by setStatus key.
 * pi-lens publishes its LSP state on every turn; the pi-lens widget already
 * surfaces it, so the footer drops it to stay single-line. Match on the key,
 * since the text carries ANSI color codes. Extend to silence more.
 */
const HIDDEN_STATUS_KEYS = new Set(["pi-lens-lsp"]);

export function isHiddenExtensionStatus(key: string): boolean {
	return HIDDEN_STATUS_KEYS.has(key);
}

/**
 * Block meter cells: how many of `cells` blocks are filled for `percent`.
 * ceil(percent/10) semantics, same as the opencode reference (cells=10).
 */
export function meterCells(percent: number, cells = 10): number {
	const clamped = Math.max(0, Math.min(100, percent));
	return Math.ceil((clamped / 100) * cells);
}
