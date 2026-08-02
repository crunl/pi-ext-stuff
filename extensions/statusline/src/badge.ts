/**
 * Mode badge decoration for the editor top border.
 *
 * Auto mode is a hand-off state (tools run without human confirmation),
 * so the badge uses the theme's `warning` color as background — the
 * terminal-UI convention for "attention, not alarm". YOLO drops human
 * review entirely, so it escalates to the `error` color (red — alarm).
 * Falls back to inverse video when the theme is unavailable or not
 * truecolor.
 *
 * This file must not import pi packages (tests run under bare node).
 */

/** Theme color backing the badge for a given severity ("none" never renders). */
export function badgeColorFor(
	severity: "warning" | "error",
): "warning" | "error" {
	return severity;
}

/** Parse a truecolor SGR sequence (38/48;2;r;g;b) into RGB. */
export function parseTruecolor(ansi: string): [number, number, number] | null {
	const match = ansi.match(/[34]8;2;(\d+);(\d+);(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const INVERSE = (segment: string): string => `\x1b[7m${segment}\x1b[27m`;

/**
 * Black or white text for a badge background, by perceived luminance
 * (YIQ luma, threshold 128). Light backgrounds (e.g. Catppuccin mocha's
 * pale red) keep black text; dark ones (e.g. latte's deep red) switch to
 * white so the label stays readable across mixed themes.
 */
export function contrastTextFor(rgb: [number, number, number]): string {
	const [r, g, b] = rgb;
	const luma = (299 * r + 587 * g + 114 * b) / 1000;
	return luma >= 128 ? "\x1b[30m" : "\x1b[97m";
}

/**
 * Build the badge decorator from the badge color's foreground ANSI.
 * Colored background with contrast-aware text (black or white, per
 * luminance); layout-neutral (zero-width codes only).
 */
export function makeModeBadgeDecorator(
	badgeFgAnsi: string | undefined,
): (segment: string) => string {
	const rgb = badgeFgAnsi ? parseTruecolor(badgeFgAnsi) : null;
	if (!rgb) return INVERSE;
	const open = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${contrastTextFor(rgb)}`;
	// Reset both fg and bg of the segment, then let the outer borderColor
	// sequence continue coloring the rest of the line.
	return (segment) => `${open}${segment}\x1b[39m\x1b[49m`;
}
