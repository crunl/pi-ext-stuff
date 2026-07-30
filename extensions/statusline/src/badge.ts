/**
 * Mode badge decoration for the editor top border.
 *
 * Auto mode is a hand-off state (tools run without human confirmation),
 * so the badge uses the theme's `warning` color as background — the
 * terminal-UI convention for "attention, not alarm". Falls back to
 * inverse video when the theme is unavailable or not truecolor.
 *
 * This file must not import pi packages (tests run under bare node).
 */

/** Parse a truecolor SGR sequence (38/48;2;r;g;b) into RGB. */
export function parseTruecolor(ansi: string): [number, number, number] | null {
	const match = ansi.match(/[34]8;2;(\d+);(\d+);(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const INVERSE = (segment: string): string => `\x1b[7m${segment}\x1b[27m`;

/**
 * Build the badge decorator from the theme's warning foreground ANSI.
 * Yellow background + black text; layout-neutral (zero-width codes only).
 */
export function makeModeBadgeDecorator(
	warningFgAnsi: string | undefined,
): (segment: string) => string {
	const rgb = warningFgAnsi ? parseTruecolor(warningFgAnsi) : null;
	if (!rgb) return INVERSE;
	const open = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m\x1b[30m`;
	// Reset both fg and bg of the segment, then let the outer borderColor
	// sequence continue coloring the rest of the line.
	return (segment) => `${open}${segment}\x1b[39m\x1b[49m`;
}
