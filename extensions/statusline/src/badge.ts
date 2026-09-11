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
 * Two shapes:
 * - "pill" (default): powerline half-circle caps + colored body
 *     ──Auto───────  (caps U+E0B6 / U+E0B4)
 * - "inset": colored body only, for boxed editors where the corner
 *   already curves and a pill would stack a second arc
 *     ╭─Auto───────╮
 *
 * This file must not import pi packages (tests run under bare node).
 */

/** Powerline half-circle caps (extra glyphs). */
export const PL_LEFT = "\uE0B6";
export const PL_RIGHT = "\uE0B4";

/** Visible width the decorator adds around the label (two caps in pill mode). */
export const BADGE_CAP_WIDTH = 2;

export type BadgeStyle = "pill" | "inset";

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
 * Input is the plain label ("Auto"); output is the decorated segment.
 * Pill style adds two visible cap columns; inset style is width-neutral.
 */
export function makeModeBadgeDecorator(
	badgeFgAnsi: string | undefined,
	style: BadgeStyle = "pill",
): (segment: string) => string {
	const rgb = badgeFgAnsi ? parseTruecolor(badgeFgAnsi) : null;
	if (style === "inset") {
		if (!rgb) return INVERSE;
		const open = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${contrastTextFor(rgb)}`;
		return (segment) => `${open}${segment}\x1b[39m\x1b[49m`;
	}
	if (!rgb) return (segment) => INVERSE(`${PL_LEFT}${segment}${PL_RIGHT}`);
	const [r, g, b] = rgb;
	const capFg = `\x1b[38;2;${r};${g};${b}m`;
	const bodyOpen = `\x1b[48;2;${r};${g};${b}m${contrastTextFor(rgb)}`;
	// Caps use badge color as foreground (transparent bg); body uses it as
	// background. Reset both channels after the body so borderColor(post)
	// resumes cleanly.
	return (segment) =>
		`${capFg}${PL_LEFT}\x1b[39m` +
		`${bodyOpen}${segment}\x1b[39m\x1b[49m` +
		`${capFg}${PL_RIGHT}\x1b[39m`;
}