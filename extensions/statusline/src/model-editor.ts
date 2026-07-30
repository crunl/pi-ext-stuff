/**
 * Model-line editor — a CustomEditor whose borders embed status info:
 *
 *   ──▐Auto▌───────────── ↑284k ↓37.3k ──  <- top: mode badge left, stats right
 *    > user input here…
 *   ── (provider) model•effort ───────────────  <- bottom border, left side
 *
 * The mode badge uses a mode-dependent theme color as background: warning
 * (yellow — "attention, not alarm") for Auto, error (red — alarm) for YOLO.
 * Falls back to inverse video without truecolor theme data.
 *
 * Pattern follows examples/extensions/modal-editor.ts: subclass CustomEditor,
 * post-process super.render() output, splice labels into the border lines.
 * Borders keep their dynamic color (thinking level / bash mode) because we
 * re-color the rebuilt line via this.borderColor. Scroll-indicator borders
 * ("─── ↓ 2 more ──") are left untouched to preserve that information.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { badgeColorFor, makeModeBadgeDecorator } from "./badge.ts";
import { buildBottomBorder, buildTopBorder } from "./border-labels.ts";

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
	/** Badge-color ANSI provider (captured lazily from the footer theme). */
	getBadgeFgAnsi: (color: "warning" | "error") => string | undefined = () => undefined;

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

		// Top border: mode badge on the left, token stats on the right
		//   ──▐Auto▌────────── ↑284k ↓37.3k ──
		// Mode is omitted for Default (only non-default modes are called out).
		// Border runs and the badge are colored separately: the badge's own
		// fg/bg codes must not leak into (or cut) the border color.
		if (topIdx !== -1) {
			const mode = this.getPermissionsMode();
			const top = buildTopBorder(width, mode, this.getStats());
			if (top !== undefined) {
				// Builders guarantee pre+mode+post is exactly `width` (tested),
				// so no re-truncation is needed here.
				const decorate = makeModeBadgeDecorator(
					mode ? this.getBadgeFgAnsi(badgeColorFor(mode)) : undefined,
				);
				const badge = top.mode.length > 0 ? decorate(top.mode) : "";
				lines[topIdx] =
					this.borderColor(top.pre) + badge + this.borderColor(top.post);
			}
		}

		// Bottom border: model info  ── (provider) model•effort ──
		const info = this.getModelInfo();
		if (info && bottomIdx !== -1 && bottomIdx !== topIdx) {
			const bottom = buildBottomBorder(width, info);
			if (bottom !== undefined) {
				lines[bottomIdx] = this.borderColor(bottom);
			}
		}

		return lines;
	}
}

const ANSI_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}
