/**
 * Model-line editor — a CustomEditor whose chrome embeds status info
 * inside a rounded box:
 *
 *   ╭──Auto─────────────── ↑284k ↓37.3k ─╮
 *   │ user input here…                   │
 *   ╰────────────────────────────────────╯
 *
 * Bottom border is a plain rule when SHOW_MODEL_ON_BORDER is false —
 * the footer owns model/effort display as powerline segments.
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

import { makeModeBadgeDecorator } from "./badge.ts";
import { buildBottomBorder, buildTopBorder } from "./border-labels.ts";
import { BOX_MIN_WIDTH, boxEditorLines } from "./box-editor.ts";
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

export interface BoxChromeProviders {
	getModelInfo?: ModelInfoProvider;
	getStats?: StatsProvider;
	getPermissionsMode?: PermissionsModeProvider;
	getBadgeFgAnsi?: (color: "warning" | "error") => string | undefined;
	getPillFgAnsi?: (color: ModelPillColor) => string | undefined;
	isEnabled?: () => boolean;
}

export interface BorderColorable {
	borderColor?(text: string): string;
}

export interface RenderableEditor {
	render(width: number): string[];
}

const BOX_CHROME_APPLIED = Symbol.for("@x1a2h1/statusline:box-chrome-applied");

/**
 * Decorates an existing editor instance in-place with statusline's boxed chrome.
 *
 * Wraps editor.render() rather than replacing the editor class, preserving any
 * other decorations (such as autocomplete-above) applied by earlier extensions.
 */
export const SHOW_MODEL_ON_BORDER = false;

export function applyBoxChrome<T extends RenderableEditor>(
	editor: T,
	providers: BoxChromeProviders = {},
): T {
	if ((editor as Record<symbol, unknown>)[BOX_CHROME_APPLIED]) {
		return editor;
	}
	(editor as Record<symbol, unknown>)[BOX_CHROME_APPLIED] = true;

	const originalRender = editor.render.bind(editor);
	const {
		getModelInfo = () => undefined,
		getStats = () => undefined,
		getPermissionsMode = () => undefined,
		getBadgeFgAnsi = () => undefined,
		getPillFgAnsi = () => undefined,
		isEnabled = () => true,
	} = providers;

	editor.render = (width: number): string[] => {
		if (!isEnabled()) {
			return originalRender(width);
		}

		const boxed = width >= BOX_MIN_WIDTH;
		const innerWidth = boxed ? width - 2 : width;
		const lines = originalRender(innerWidth);
		if (lines.length === 0) return lines;

		const colorizeBorder = (text: string): string => {
			const borderFn = (editor as BorderColorable).borderColor;
			return typeof borderFn === "function" ? borderFn.call(editor, text) : text;
		};

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
		if (topIdx !== -1) {
			const mode = getPermissionsMode();
			const top = buildTopBorder(innerWidth, mode?.label, getStats());
			if (top !== undefined) {
				const decorate = makeModeBadgeDecorator(
					mode ? getBadgeFgAnsi(mode.severity) : undefined,
				);
				const badge = top.mode.length > 0 ? decorate(top.mode) : "";
				lines[topIdx] =
					colorizeBorder(top.pre) + badge + colorizeBorder(top.post);
			}
		}

		// Bottom border: model/effort powerline pill (optional).
		const info = getModelInfo();
		if (
			SHOW_MODEL_ON_BORDER &&
			info &&
			bottomIdx !== -1 &&
			bottomIdx !== topIdx
		) {
			const bottom = buildBottomBorder(
				innerWidth,
				info,
				getPillFgAnsi("mdLink"),
				getPillFgAnsi("accent"),
			);
			if (bottom !== undefined) {
				lines[bottomIdx] =
					colorizeBorder(bottom.pre) + bottom.pill + colorizeBorder(bottom.post);
			}
		}

		if (!boxed) return lines;
		if (topIdx === -1 || bottomIdx === -1) return lines;

		return boxEditorLines(lines, innerWidth, colorizeBorder, {
			topIdx,
			bottomIdx,
		});
	};

	return editor;
}

export type CustomEditorLike = RenderableEditor & BorderColorable;
