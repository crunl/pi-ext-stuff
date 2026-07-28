/**
 * Model-line editor — a CustomEditor whose borders embed status info:
 *
 *   ──────────────────────────────── ↑284k ↓37.3k ──  <- top border, right side
 *    > user input here…
 *   ── Default•(provider) model•effort ───────────────  <- bottom border, left side
 *
 * Pattern follows examples/extensions/modal-editor.ts: subclass CustomEditor,
 * post-process super.render() output, splice labels into the border lines.
 * Borders keep their dynamic color (thinking level / bash mode) because we
 * re-color the rebuilt line via this.borderColor. Scroll-indicator borders
 * ("─── ↓ 2 more ──") are left untouched to preserve that information.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./format.ts";
import { formatModelStatus } from "./status-mode.ts";

export interface ModelInfoProvider {
	(): { provider: string; modelId: string; effort: string | undefined } | undefined;
}

export interface StatsProvider {
	(): { input: number; output: number } | undefined;
}

export interface PermissionsModeProvider {
	(): string | undefined;
}

export class ModelLineEditor extends CustomEditor {
	/** Injected callback returning current model info (reads live ctx). */
	getModelInfo: ModelInfoProvider = () => undefined;
	/** Injected callback returning token totals for the top border. */
	getStats: StatsProvider = () => undefined;
	/** Injected callback returning the mode published by pi-permissions. */
	getPermissionsMode: PermissionsModeProvider = () => undefined;

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// Locate pure horizontal border lines (all ─ after stripping ANSI).
		let topIdx = -1;
		let bottomIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			const plain = stripAnsi(lines[i]!);
			if (plain.length > 0 && /^─+$/.test(plain)) {
				if (topIdx === -1) topIdx = i;
				bottomIdx = i;
			}
		}

		// Top border: right-aligned token stats  ───── ↑284k ↓37.3k ──
		const stats = this.getStats();
		if (stats && topIdx !== -1 && (stats.input > 0 || stats.output > 0)) {
			const label = ` ↑${formatTokens(stats.input)} ↓${formatTokens(stats.output)} ──`;
			const labelWidth = visibleWidth(label);
			if (labelWidth < width) {
				const leading = "─".repeat(width - labelWidth);
				lines[topIdx] = this.borderColor(truncateToWidth(leading + label, width, ""));
			}
		}

		// Bottom border: mode + model info  ── Default•(provider) model•effort ──
		const info = this.getModelInfo();
		if (info && bottomIdx !== -1 && bottomIdx !== topIdx) {
			const label = formatModelStatus(info, this.getPermissionsMode());
			const decorated = `── ${label} `;
			const labelWidth = visibleWidth(decorated);
			if (labelWidth < width) {
				const rest = "─".repeat(width - labelWidth);
				lines[bottomIdx] = this.borderColor(truncateToWidth(decorated + rest, width, ""));
			}
		}

		return lines;
	}
}

const ANSI_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}
