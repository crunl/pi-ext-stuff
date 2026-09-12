/**
 * Model-line editor — a CustomEditor whose chrome embeds status info
 * inside a rounded box:
 *
 *   ╭──Auto─────────────── ↑284k ↓37.3k ─╮
 *   │ user input here…                   │
 *   ╰──modeleffort──────────╯
 *
 * Mode badge keeps the powerline half-circle pill, sitting in the top
 * border after the box corner. Mode color: warning (yellow — "attention,
 * not alarm") for Auto, error (red — alarm) for YOLO. Falls back to
 * inverse video without truecolor theme data.
 *
 * Renders the upstream Editor at width-2, splices labels into the inner
 * borders, then wraps with boxEditorLines. Scroll-indicator borders
 * ("─── ↓ 2 more ──") are preserved inside the box. Narrow widths fall
 * back to the unboxed layout.
 *
 * Pattern follows examples/extensions/modal-editor.ts: subclass CustomEditor,
 * post-process super.render() output.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { makeModeBadgeDecorator } from "./badge.ts";
import { BOX_MIN_WIDTH, boxEditorLines } from "./box-editor.ts";
import { buildBottomBorder, buildTopBorder } from "./border-labels.ts";
import { stripAnsi } from "./format.ts";

export interface ModelInfoProvider {
	(): { modelId: string; effort: string | undefined } | undefined;
}

export interface StatsProvider {
	(): { input: number; output: number } | undefined;
}

export interface PermissionsModeProvider {
	(): { label: string; severity: "warning" | "error" } | undefined;
}

/** Theme color key used for the model/effort powerline segments. */
export type ModelPillColor = "mdLink" | "accent";

export class ModelLineEditor extends CustomEditor {
	/** Injected callback returning current model info (reads live ctx). */
	getModelInfo: ModelInfoProvider = () => undefined;
	/** Injected callback returning token totals for the top border. */
	getStats: StatsProvider = () => undefined;
	/** Injected callback returning the mode published by pi-permissions. */
	getPermissionsMode: PermissionsModeProvider = () => undefined;
	/** Badge-color ANSI provider (captured lazily from the footer theme). */
	getBadgeFgAnsi: (color: "warning" | "error") => string | undefined = () => undefined;
	/** Model/effort pill color provider (truecolor fg used as segment bg). */
	getPillFgAnsi: (color: ModelPillColor) => string | undefined = () => undefined;

	render(width: number): string[] {
		const boxed = width >= BOX_MIN_WIDTH;
		const innerWidth = boxed ? width - 2 : width;
		const lines = super.render(innerWidth);
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

		// Top border: powerline mode pill on the left, token stats on the right.
		// Caps stay in boxed mode — the pill sits after the corner, not on it.
		if (topIdx !== -1) {
			const mode = this.getPermissionsMode();
			const top = buildTopBorder(innerWidth, mode?.label, this.getStats());
			if (top !== undefined) {
				const decorate = makeModeBadgeDecorator(
					mode ? this.getBadgeFgAnsi(mode.severity) : undefined,
				);
				const badge = top.mode.length > 0 ? decorate(top.mode) : "";
				lines[topIdx] =
					this.borderColor(top.pre) + badge + this.borderColor(top.post);
			}
		}

		// Bottom border: model/effort powerline pill. Color border runs
		// separately — the pill's resets would cut the border color.
		const info = this.getModelInfo();
		if (info && bottomIdx !== -1 && bottomIdx !== topIdx) {
			const bottom = buildBottomBorder(
				innerWidth,
				info,
				this.getPillFgAnsi("mdLink"),
				this.getPillFgAnsi("accent"),
			);
			if (bottom !== undefined) {
				lines[bottomIdx] =
					this.borderColor(bottom.pre) + bottom.pill + this.borderColor(bottom.post);
			}
		}

		if (!boxed) return lines;
		// Labels are already spliced in, so the borders are no longer pure ─
		// runs — hand boxEditorLines the indices we just used.
		if (topIdx === -1 || bottomIdx === -1) return lines;
		return boxEditorLines(lines, innerWidth, (s) => this.borderColor(s), {
			topIdx,
			bottomIdx,
		});
	}
}
