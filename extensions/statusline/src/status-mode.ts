import { contrastTextFor, parseTruecolor, PL_LEFT, PL_RIGHT } from "../../../packages/shared-tool-presentation/src/badge.ts";

/** Powerline right solid arrowhead — segment divider inside the pill. */
const PL_SEP = "";

export interface ModelStatusInfo {
	modelId: string;
	effort: string | undefined;
}

export interface PowerlineSegment {
	text: string;
	/** Truecolor foreground used as the segment background. */
	ansi?: string;
}

/**
 * Chain segments into a powerline pill:
 *
 *   model  effort  folder …
 *
 * Caps use the adjacent segment color as fg; bodies use it as bg.
 * Every segment body is padded with a trailing space (so text does not
 * sit flush against the next sep or the right cap). Segments after the
 * first also get a leading space after the arrowhead. Model (first) stays
 * tight on the left. Falls back to inverse video when a color is missing.
 */
export function powerlineChain(segments: readonly PowerlineSegment[]): string {
	if (segments.length === 0) return "";
	const first = segments[0]!;
	let out = cap(PL_LEFT, first.ansi) + body(`${first.text} `, first.ansi);
	for (let i = 1; i < segments.length; i += 1) {
		const prev = segments[i - 1]!;
		const cur = segments[i]!;
		out += sep(prev.ansi, cur.ansi) + body(` ${cur.text} `, cur.ansi);
	}
	return out + cap(PL_RIGHT, segments[segments.length - 1]!.ansi);
}

function cap(glyph: string, ansi: string | undefined): string {
	const rgb = ansi ? parseTruecolor(ansi) : null;
	if (!rgb) return glyph;
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${glyph}\x1b[39m`;
}

function body(text: string, ansi: string | undefined): string {
	const rgb = ansi ? parseTruecolor(ansi) : null;
	if (!rgb) return `\x1b[7m${text}\x1b[27m`;
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${contrastTextFor(rgb)}${text}\x1b[39m\x1b[49m`;
}

/** Arrowhead drawn in the left segment's color over the right segment's bg. */
function sep(leftAnsi: string | undefined, rightAnsi: string | undefined): string {
	const left = leftAnsi ? parseTruecolor(leftAnsi) : null;
	if (!left) return PL_SEP;
	const fg = `\x1b[38;2;${left[0]};${left[1]};${left[2]}m`;
	const right = rightAnsi ? parseTruecolor(rightAnsi) : null;
	const bg = right
		? `\x1b[48;2;${right[0]};${right[1]};${right[2]}m`
		: "\x1b[49m";
	return `${fg}${bg}${PL_SEP}\x1b[39m\x1b[49m`;
}

export function partitionExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): { mode: string | undefined; remaining: Array<[string, string]> } {
	const publishedMode = statuses.get("pi-safety");
	return {
		mode: publishedMode,
		remaining: [...statuses.entries()].filter(
			([key]) => key !== "pi-safety",
		),
	};
}

export function syncPermissionsMode(
	statuses: ReadonlyMap<string, string>,
): Array<[string, string]> {
	return partitionExtensionStatuses(statuses).remaining;
}

