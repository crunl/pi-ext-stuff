/**
 * Mode badge decoration for the editor top border.
 *
 * Auto mode is a hand-off state (tools run without human confirmation),
 * so the badge is golden — attention, not alarm. YOLO drops human review
 * entirely, so it escalates to dark red. The colors are fixed (not theme
 * semantic colors) so the badge stays recognizable across themes; the
 * text is black or white picked from the background's perceived
 * luminance via contrastTextFor.
 *
 * This file must not import pi packages (tests run under bare node).
 */

export type BadgeSeverity = "warning" | "error";

/** Fixed badge backgrounds: gold #FFD700 (auto) and dark red #8B0000 (yolo). */
const BADGE_RGB: Record<BadgeSeverity, [number, number, number]> = {
	warning: [255, 215, 0],
	error: [139, 0, 0],
};

/**
 * Black or white text for a badge background, by perceived luminance
 * (YIQ luma, threshold 128). Light backgrounds (gold) keep black text;
 * dark ones (dark red) switch to white so the label stays readable.
 */
export function contrastTextFor(rgb: [number, number, number]): string {
	const [r, g, b] = rgb;
	const luma = (299 * r + 587 * g + 114 * b) / 1000;
	return luma >= 128 ? "\x1b[30m" : "\x1b[97m";
}

/**
 * Build the badge decorator for a severity. Fixed colored background with
 * contrast-aware text (black or white, per luminance); layout-neutral
 * (zero-width codes only).
 */
export function makeModeBadgeDecorator(
	severity: BadgeSeverity,
): (segment: string) => string {
	const [r, g, b] = BADGE_RGB[severity];
	const open = `\x1b[48;2;${r};${g};${b}m${contrastTextFor([r, g, b])}`;
	// Reset both fg and bg of the segment, then let the outer borderColor
	// sequence continue coloring the rest of the line.
	return (segment) => `${open}${segment}\x1b[39m\x1b[49m`;
}
