/**
 * Catppuccin powerline palettes for the statusline left chain.
 *
 * Dark = Frappé accents; Light = Latte accents (cap contrast on pale
 * backgrounds). Layout: model | effort | folder | git.
 *
 * Dark fixed: model=mauve, folder=sky, git=yellow.
 * Dark effort (docs/dark-palette-effort-research.md):
 *   green → blue → rosewater → flamingo → peach → pink.
 *
 * Light fixed: model=mauve (not error-red), folder=teal, git=yellow.
 * Light effort (docs/light-palette-effort-research.md):
 *   green → blue → lavender → flamingo → peach → pink.
 *   medium uses lavender, not rosewater — Latte rosewater→flamingo
 *   adjacent ΔE is only 4.3 and would blur level changes.
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
		model: "#8839ef",
		folder: "#179299",
		git: "#df8e1d",
	},
	effort: {
		minimal: "#40a02b",
		low: "#1e66f5",
		medium: "#7287fd",
		high: "#dd7878",
		xhigh: "#fe640b",
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
