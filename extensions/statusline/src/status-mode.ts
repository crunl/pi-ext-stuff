import { contrastTextFor, parseTruecolor, PL_LEFT, PL_RIGHT } from "./badge.ts";
import { ICONS } from "./format.ts";

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
	for (let i = 1; i < segments.length; i++) {
		const prev = segments[i - 1]!;
		const cur = segments[i]!;
		out += sep(prev.ansi, cur.ansi) + body(` ${cur.text} `, cur.ansi);
	}
	return out + cap(PL_RIGHT, segments[segments.length - 1]!.ansi);
}

/**
 * Bottom-border label: powerline pill with model, optional effort segment
 * split by a half-triangle. Mode lives in the top border.
 *
 *   model
 *   modeleffort
 */
export function formatModelStatus(
	info: ModelStatusInfo,
	modelAnsi?: string,
	effortAnsi?: string,
): string {
	const segments: PowerlineSegment[] = [
		{ text: `${ICONS.model} ${info.modelId}`, ansi: modelAnsi },
	];
	if (info.effort) {
		segments.push({ text: `${ICONS.effort} ${info.effort}`, ansi: effortAnsi });
	}
	return powerlineChain(segments);
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

/** Badge severity published by pi-permissions ("none" hides the badge). */
export type ModeSeverity = "none" | "warning" | "error";

/** Structured mode event from pi-permissions ("pi-permissions:mode"). */
export interface PermissionsModeEvent {
	mode: string;
	label: string;
	severity: ModeSeverity;
}

export function isPermissionsModeEvent(
	data: unknown,
): data is PermissionsModeEvent {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Record<string, unknown>;
	return (
		typeof record.mode === "string" &&
		typeof record.label === "string" &&
		(record.severity === "none" ||
			record.severity === "warning" ||
			record.severity === "error")
	);
}

/**
 * Legacy string fallback for pi-permissions builds that only publish
 * setStatus text. Kept in sync with the last known label set; the event
 * path makes future renames non-breaking.
 */
function legacySeverityFor(label: string): ModeSeverity {
	if (label === "default") return "none";
	if (label === "Full bypass") return "error";
	return "warning";
}

export function partitionExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
): { mode: string | undefined; remaining: Array<[string, string]> } {
	const publishedMode = statuses.get("pi-permissions");
	return {
		mode: publishedMode,
		remaining: [...statuses.entries()].filter(
			([key]) => key !== "pi-permissions",
		),
	};
}

/**
 * Permissions badge state. Fed by two sources:
 * - preferred: structured "pi-permissions:mode" bus events (applyEvent)
 * - fallback: the setStatus string (applyLegacyLabel), used only until the
 *   first event arrives so old pi-permissions builds keep working.
 */
export class PermissionsModeState {
	#label: string | undefined;
	#severity: ModeSeverity = "none";
	#eventSeen = false;

	/** Badge text, or undefined when the badge is hidden. */
	get(): string | undefined {
		return this.#severity === "none" ? undefined : this.#label;
	}

	severity(): ModeSeverity {
		return this.#severity;
	}

	/** Apply a structured mode event. Returns true when a render is needed. */
	applyEvent(event: PermissionsModeEvent): boolean {
		this.#eventSeen = true;
		return this.#set(event.label, event.severity);
	}

	/** Apply the legacy setStatus string. Ignored once events are flowing. */
	applyLegacyLabel(label: string | undefined): boolean {
		if (this.#eventSeen) return false;
		if (label === undefined) return this.#set(undefined, "none");
		return this.#set(label, legacySeverityFor(label));
	}

	/** Reset (e.g. statusline uninstall). Keeps the event/legacy source flag. */
	reset(): boolean {
		return this.#set(undefined, "none");
	}

	#set(label: string | undefined, severity: ModeSeverity): boolean {
		// A hidden badge has no visible label: normalize so default→default
		// label churn never reports a spurious render.
		const effectiveLabel = severity === "none" ? undefined : label;
		if (this.#label === effectiveLabel && this.#severity === severity)
			return false;
		this.#label = effectiveLabel;
		this.#severity = severity;
		return true;
	}
}

export function syncPermissionsMode(
	statuses: ReadonlyMap<string, string>,
	state: PermissionsModeState,
	requestRender: () => void,
): Array<[string, string]> {
	const { mode, remaining } = partitionExtensionStatuses(statuses);
	if (state.applyLegacyLabel(mode)) requestRender();
	return remaining;
}
