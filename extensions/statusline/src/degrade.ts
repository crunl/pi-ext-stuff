import {
	formatTokens,
	ICONS,
	isHiddenExtensionStatus,
	meterCells,
	sanitizeStatusText,
} from "./format.ts";
import {
	coloredSpan,
	dedupeNarrowing,
	EMPTY_SPAN,
	type Measure,
	joinSpans,
	paint,
	selectFitting,
	type Span,
	span,
} from "./layout.ts";
import { fgRgb, powerlineChain } from "./powerline.ts";
import { syncPermissionsMode } from "./status-mode.ts";
import type { Rgb } from "./palette.ts";

export type Fg = (color: string, text: string) => string;
export type LeftKey = "model" | "effort" | "folder" | "branch";

export interface LeftSeg {
	key: LeftKey;
	text: string;
	rgb: Rgb;
	icon: string;
}

export interface LeftInput {
	segments: readonly LeftSeg[];
}

export interface RightInput {
	cacheRate: number | undefined;
	usage:
		| { percent: number | null; tokens: number | null; window: number }
		| undefined;
}

export interface FooterData {
	left: LeftInput;
	right: RightInput;
}

type Chrome = "pill" | "plain";
type Meter = 10 | 5 | 0;
type UsageMode = "tokens" | "percent" | "icon" | "none";

/** One complete presentation state. Each shed step changes one field. */
export interface View {
	chrome: Chrome;
	branch: boolean;
	effort: boolean;
	folder: boolean;
	cache: boolean;
	meter: Meter;
	usage: UsageMode;
}

export const FULL_VIEW: View = {
	chrome: "pill",
	branch: true,
	effort: true,
	folder: true,
	cache: true,
	meter: 10,
	usage: "tokens",
};

type ShedOperation =
	| { side: "right"; patch: Partial<Pick<View, "cache" | "meter" | "usage">> }
	| { side: "left"; patch: Pick<View, "chrome"> }
	| { side: "left"; dropNextLeft: true };

/** Information-shedding plan, ordered from richest to leanest. */
export const SHED: readonly ShedOperation[] = [
	{ side: "right", patch: { cache: false } },
	{ side: "right", patch: { meter: 5 } },
	{ side: "right", patch: { meter: 0 } },
	{ side: "left", patch: { chrome: "plain" } },
	{ side: "left", dropNextLeft: true },
	{ side: "right", patch: { usage: "percent" } },
	{ side: "left", dropNextLeft: true },
	{ side: "left", dropNextLeft: true },
	{ side: "right", patch: { usage: "icon" } },
	{ side: "right", patch: { usage: "none" } },
];

const LEFT_DROP_ORDER: readonly LeftKey[] = ["branch", "effort", "folder"];

export function shedViews(
	availableLeftKeys: readonly LeftKey[] = ["model", "effort", "folder", "branch"],
): View[] {
	const views = [FULL_VIEW];
	let current = FULL_VIEW;
	let nextLeftDrop = 0;
	for (const operation of SHED) {
		if (operation.side === "right") {
			current = { ...current, ...operation.patch };
		} else if ("patch" in operation) {
			current = { ...current, ...operation.patch };
		} else {
			while (
				nextLeftDrop < LEFT_DROP_ORDER.length &&
				!availableLeftKeys.includes(LEFT_DROP_ORDER[nextLeftDrop]!)
			) {
				nextLeftDrop += 1;
			}
			if (nextLeftDrop === LEFT_DROP_ORDER.length) continue;
			const key = LEFT_DROP_ORDER[nextLeftDrop]!;
			current = { ...current, [key]: false };
			nextLeftDrop += 1;
		}
		views.push(current);
	}
	return views;
}

const METER_CELLS_COMPACT = 5;

function visibleSegments(input: LeftInput, view: View): readonly LeftSeg[] {
	return input.segments.filter(
		(segment) =>
			segment.key === "model" ||
			(segment.key === "branch" && view.branch) ||
			(segment.key === "effort" && view.effort) ||
			(segment.key === "folder" && view.folder),
	);
}

function renderLeft(input: LeftInput, view: View, measure: Measure, fg: Fg): Span {
	const segments = visibleSegments(input, view);
	if (segments.length === 0) return EMPTY_SPAN;

	if (view.chrome === "pill") {
		const chain = powerlineChain(
			segments.map((segment) => ({
				text: `${segment.icon} ${segment.text}`,
				rgb: segment.rgb,
			})),
		);
		return coloredSpan(chain, measure(chain));
	}

	const separator = coloredSpan(fg("dim", " | "), measure(" | "));
	return joinSpans(
		segments.map((segment) =>
			paint(span(segment.text, measure), (text) => `${fgRgb(segment.rgb, text)}\x1b[39m`),
		),
		separator,
	);
}

function meterColorFor(percent: number | null): string {
	if (percent === null) return "dim";
	return percent >= 75 ? "error" : percent >= 50 ? "warning" : "success";
}

function renderMeter(
	percent: number | null,
	cells: Meter,
	measure: Measure,
	fg: Fg,
	color: string,
): Span {
	if (cells === 0 || percent === null) return EMPTY_SPAN;
	const filled = meterCells(percent, cells === 5 ? METER_CELLS_COMPACT : cells);
	const fill = filled > 0
		? paint(span("█".repeat(filled), measure), (text) => fg(color, text))
		: EMPTY_SPAN;
	const rest = filled < cells
		? paint(span("░".repeat(cells - filled), measure), (text) => fg("dim", text))
		: EMPTY_SPAN;
	return joinSpans([fill, rest], EMPTY_SPAN);
}

function renderRight(input: RightInput, view: View, measure: Measure, fg: Fg): Span {
	const space = span(" ", measure);
	const gap = span("  ", measure);
	const cache = view.cache && input.cacheRate !== undefined
		? joinSpans(
			[
				paint(span(ICONS.cache, measure), (text) => fg("accent", text)),
				paint(span(`CH${input.cacheRate.toFixed(1)}%`, measure), (text) => fg("dim", text)),
			],
			space,
		)
		: EMPTY_SPAN;

	const usage = input.usage;
	if (!usage || view.usage === "none") return cache;

	const color = meterColorFor(usage.percent);
	const icon = paint(span(ICONS.gauge, measure), (text) => fg("accent", text));
	let usageBlock: Span;
	if (view.usage === "icon") {
		usageBlock = icon;
	} else if (view.usage === "percent") {
		const percent = paint(
			span(usage.percent === null ? "?" : `${Math.round(usage.percent)}%`, measure),
			(text) => fg(color, text),
		);
		usageBlock = joinSpans([icon, percent], space);
	} else {
		const meter = renderMeter(usage.percent, view.meter, measure, fg, color);
		const tokens = paint(
			span(
				usage.tokens === null
					? `?/${formatTokens(usage.window)}`
					: `${formatTokens(usage.tokens)}/${formatTokens(usage.window)}`,
				measure,
			),
			(text) => fg(color, text),
		);
		usageBlock = joinSpans([icon, meter, tokens], space);
	}
	return joinSpans([cache, usageBlock], gap);
}

export interface FooterCandidate {
	readonly left: Span;
	readonly right: Span;
}

export interface FooterLayoutDeps {
	measure: Measure;
	fg: Fg;
	data: FooterData;
}

export function buildCandidates(deps: FooterLayoutDeps): FooterCandidate[] {
	const availableLeftKeys = deps.data.left.segments.map((segment) => segment.key);
	const candidates = shedViews(availableLeftKeys).map((view) => ({
		left: renderLeft(deps.data.left, view, deps.measure, deps.fg),
		right: renderRight(deps.data.right, view, deps.measure, deps.fg),
	}));
	return dedupeNarrowing(candidates);
}

export type Truncate = (text: string, width: number, suffix?: string) => string;

export interface RenderFooterInput {
	width: number;
	pad: number;
	left: LeftInput;
	right: RightInput;
	statuses: ReadonlyMap<string, string>;
}

export interface RenderFooterDeps {
	measure: Measure;
	truncate: Truncate;
	fg: Fg;
	minPadding?: number;
}

function composeLine(
	candidate: FooterCandidate,
	innerWidth: number,
	fits: boolean,
	deps: RenderFooterDeps,
): Span {
	if (!fits) {
		const truncated = deps.truncate(candidate.left.text, innerWidth, deps.fg("dim", "…"));
		return { text: truncated, width: deps.measure(truncated) };
	}
	if (candidate.right.width === 0) return candidate.left;
	const padding = Math.max(0, innerWidth - candidate.left.width - candidate.right.width);
	return {
		text: candidate.left.text + " ".repeat(padding) + candidate.right.text,
		width: candidate.left.width + padding + candidate.right.width,
	};
}

export function renderFooterLines(
	input: RenderFooterInput,
	deps: RenderFooterDeps,
): string[] {
	const innerWidth = Math.max(0, input.width - input.pad * 2);
	const candidates = buildCandidates({
		measure: deps.measure,
		fg: deps.fg,
		data: { left: input.left, right: input.right },
	});
	const chosen = selectFitting(candidates, innerWidth, deps.minPadding ?? 2);
	const candidate = candidates[chosen >= 0 ? chosen : candidates.length - 1]!;
	const line = composeLine(candidate, innerWidth, chosen >= 0, deps);
	const gutter = " ".repeat(input.pad);
	const first = deps.truncate(gutter + line.text, input.width);
	const lines = [first];

	const visible = syncPermissionsMode(input.statuses).filter(
		([key]) => !isHiddenExtensionStatus(key),
	);
	if (visible.length > 0) {
		const merged = visible
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		lines.push(deps.truncate(gutter + merged, input.width));
	}
	return lines;
}
