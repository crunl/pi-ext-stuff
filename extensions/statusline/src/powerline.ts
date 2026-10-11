import { contrastTextFor, PL_LEFT, PL_RIGHT } from "../../../packages/shared-tool-presentation/src/badge.ts";
import type { Rgb } from "./palette.ts";

/** Powerline right solid arrowhead — segment divider inside the pill. */
const PL_SEP = "";

export interface PowerlineSegment {
	text: string;
	/** Truecolor used as the segment foreground and background. */
	rgb?: Rgb;
}

export function fgRgb(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}`;
}

function cap(glyph: string, rgb: Rgb | undefined): string {
	if (!rgb) return glyph;
	return `${fgRgb(rgb, glyph)}\x1b[39m`;
}

function body(text: string, rgb: Rgb | undefined): string {
	if (!rgb) return `\x1b[7m${text}\x1b[27m`;
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${contrastTextFor(rgb)}${text}\x1b[39m\x1b[49m`;
}

/** Arrowhead drawn in the left segment's color over the right segment's bg. */
function sep(left: Rgb | undefined, right: Rgb | undefined): string {
	if (!left) return PL_SEP;
	const fg = fgRgb(left, "");
	const bg = right
		? `\x1b[48;2;${right[0]};${right[1]};${right[2]}m`
		: "\x1b[49m";
	return `${fg}${bg}${PL_SEP}\x1b[39m\x1b[49m`;
}

/** Render adjacent colored segments as one powerline pill. */
export function powerlineChain(segments: readonly PowerlineSegment[]): string {
	if (segments.length === 0) return "";
	const first = segments[0]!;
	let out = cap(PL_LEFT, first.rgb) + body(`${first.text} `, first.rgb);
	for (let i = 1; i < segments.length; i += 1) {
		const previous = segments[i - 1]!;
		const current = segments[i]!;
		out += sep(previous.rgb, current.rgb) + body(` ${current.text} `, current.rgb);
	}
	return out + cap(PL_RIGHT, segments[segments.length - 1]!.rgb);
}
