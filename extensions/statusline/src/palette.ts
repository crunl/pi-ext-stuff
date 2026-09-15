/**
 * Catppuccin powerline palettes for the statusline left chain.
 *
 * Dark = Frappe accents; Light = Latte accents (cap contrast on pale
 * backgrounds). Segments: model=red, folder=peach, git=yellow,
 * session=mauve. Effort owns green→teal→blue→sky→lavender→pink so it
 * never collides with the fixed slots.
 *
 * Light/dark is detected from the live theme's userMessageBg luminance
 * (no Pi isLight API for custom themes).
 */

import { parseTruecolor } from "./badge.ts";

export type PaletteKey = "model" | "folder" | "git" | "session";
export type EffortLevel =
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface PowerlinePalette {
	fixed: Record<PaletteKey, `#${string}`>;
	effort: Record<EffortLevel, `#${string}`>;
}

/** Catppuccin Frappé — matches live theme `catppuccin-frappe`. */
export const PALETTE_DARK: PowerlinePalette = {
	fixed: {
		model: "#e78284",
		folder: "#ef9f76",
		git: "#e5c890",
		session: "#ca9ee6",
	},
	effort: {
		minimal: "#a6d189",
		low: "#81c8be",
		medium: "#8caaee",
		high: "#99d1db",
		xhigh: "#babbf1",
		max: "#f4b8e4",
	},
};

/** Catppuccin Latte — light terminal. */
export const PALETTE_LIGHT: PowerlinePalette = {
	fixed: {
		model: "#d20f39",
		folder: "#fe640b",
		git: "#df8e1d",
		session: "#8839ef",
	},
	effort: {
		minimal: "#40a02b",
		low: "#179299",
		medium: "#1e66f5",
		high: "#04a5e5",
		xhigh: "#7287fd",
		max: "#ea76cb",
	},
};

export function paletteForLight(isLight: boolean): PowerlinePalette {
	return isLight ? PALETTE_LIGHT : PALETTE_DARK;
}

/**
 * Detect a light terminal from the live theme. Pi has no reliable isLight
 * for custom themes; userMessageBg (mantle) is ~232 luma on latte and ~42
 * on frappe.
 */
export function isLightThemeFrom(
	theme: { getBgAnsi?(color: string): string } | undefined,
): boolean {
	try {
		const ansi = theme?.getBgAnsi?.("userMessageBg");
		const rgb = ansi ? parseTruecolor(ansi) : null;
		if (!rgb) return false;
		const [r, g, b] = rgb;
		return (299 * r + 587 * g + 114 * b) / 1000 >= 128;
	} catch {
		return false;
	}
}

export function effortColor(
	level: string | undefined,
	palette: PowerlinePalette,
): `#${string}` {
	if (level && level in palette.effort) {
		return palette.effort[level as EffortLevel];
	}
	return palette.effort.medium;
}

/** SGR truecolor foreground parseable by badge.parseTruecolor. */
export function truecolorFg(hex: `#${string}`): string {
	const n = Number.parseInt(hex.slice(1), 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	return `\x1b[38;2;${r};${g};${b}m`;
}
