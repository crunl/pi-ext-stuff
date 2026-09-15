/**
 * Catppuccin powerline palettes for the statusline left chain.
 *
 * Dark = Frappé accents; Light = Latte accents (cap contrast on pale
 * backgrounds). Segments: model=mauve (identity, not error-red),
 * folder=sky, git=yellow.
 *
 * Dark effort band (research: docs/dark-palette-effort-research.md,
 * model later moved red→mauve): green → blue → rosewater → flamingo →
 * peach → pink. Cross-cluster from fixed mauve/sky/yellow.
 *
 * Light/dark is detected from the live theme's userMessageBg luminance
 * (no Pi isLight API for custom themes).
 */

import { parseTruecolor } from "./badge.ts";

export type PaletteKey = "model" | "folder" | "git";
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
		model: "#ca9ee6",
		folder: "#99d1db",
		git: "#e5c890",
	},
	effort: {
		minimal: "#a6d189",
		low: "#8caaee",
		medium: "#f2d5cf",
		high: "#eebebe",
		xhigh: "#ef9f76",
		max: "#f4b8e4",
	},
};

/** Catppuccin Latte — light terminal. */
export const PALETTE_LIGHT: PowerlinePalette = {
	fixed: {
		model: "#d20f39",
		folder: "#04a5e5",
		git: "#df8e1d",
	},
	effort: {
		minimal: "#40a02b",
		low: "#179299",
		medium: "#1e66f5",
		high: "#7287fd",
		xhigh: "#dd7878",
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
