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

/** Theme color backing the badge for a given permissions mode. */
export function badgeColorFor(mode: string): "warning" | "error" {
	return mode === "full bypass" ? "error" : "warning";
}

/** Parse a truecolor SGR sequence (38/48;2;r;g;b) into RGB. */
export function parseTruecolor(ansi: string): [number, number, number] | null {
	const match = ansi.match(/[34]8;2;(\d+);(\d+);(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const INVERSE = (segment: string): string => `\x1b[7m${segment}\x1b[27m`;

/**
 * Build the badge decorator from the badge color's foreground ANSI.
 * Colored background + black text; layout-neutral (zero-width codes only).
 */
export function makeModeBadgeDecorator(
	badgeFgAnsi: string | undefined,
): (segment: string) => string {
	const rgb = badgeFgAnsi ? parseTruecolor(badgeFgAnsi) : null;
	if (!rgb) return INVERSE;
	const open = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m\x1b[30m`;
	// Reset both fg and bg of the segment, then let the outer borderColor
	// sequence continue coloring the rest of the line.
	return (segment) => `${open}${segment}\x1b[39m\x1b[49m`;
}
