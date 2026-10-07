/**
 * Catppuccin powerline palettes for the statusline left chain.
 *
 * Dark = Frappé accents; Light = Latte accents (cap contrast on pale
 * backgrounds). Layout: model | effort | folder | git.
 *
 * Dark fixed: model=mauve, folder=sky, git=yellow.
 * Dark effort:
 *   green → blue → rosewater → flamingo → peach → pink.
 *
 * Design rule (both themes, both render forms): hue = identity, lightness =
 * adaptation. Each slot keeps its hue family across themes; the Light
 * instance is the same hue pressed darker (lower OKLCh lightness) until it
 * simultaneously satisfies:
 *   - fg vs light base (#eff1f5) ≥ 4.5  (WCAG 1.4.3; covers the `|` fg form
 *     and the pill-block vs terminal boundary ≥ 3.0 per 1.4.11), and
 *   - white text vs block ≥ 4.5.
 * Pressed dark, every Light slot lands at YIQ < 128, so the existing
 * `contrastTextFor` rule keeps yielding white pill text with no rule change.
 * Dark needs no dual stops: Frappé pastels already pass both forms on the
 * dark base with black text, so Dark is frozen.
 *
 * Light fixed: model=mauve (unchanged — already 4.79/5.41), folder=deep teal,
 * git=deep ochre (never pastel yellow on a pale base: 2.31).
 * Light effort: same six hue families as Dark, pressed dark —
 *   deep green → deep blue → deep periwinkle → brick → deep orange-red →
 *   deep magenta. medium stays clear of model=mauve (ΔE ≈ 44.8), xhigh stays
 *   clear of git ochre (ΔE ≈ 32.9); the closest adjacent tiers sit at
 *   ΔE ≈ 17 (CIE76, JND ≈ 2.3; the ≥6 convention in OKLab×100 terms).
 *   (ΔE here = CIE76; adjacent effort levels are comfortably distinguishable
 *   and keep a lightness order under deuteranopia.)
 *
 * Light/dark is detected from the live theme's userMessageBg luminance
 * (no Pi isLight API for custom themes).
 */

import { parseTruecolor } from "../../../packages/shared-tool-presentation/src/badge.ts";

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

/** Catppuccin Latte — light terminal. Same hues as Dark, pressed darker (see header). */
export const PALETTE_LIGHT: PowerlinePalette = {
	fixed: {
		model: "#8839ef",
		folder: "#00787f",
		git: "#a25c00",
	},
	effort: {
		minimal: "#148002",
		low: "#0761ef",
		medium: "#4564d5",
		high: "#ae4f51",
		xhigh: "#ca3700",
		max: "#b03f95",
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
