import assert from "node:assert/strict";
import test from "node:test";
import {
	buildFooterCandidates,
	buildLeftForms,
	buildRightForms,
	type LeftSeg,
	type RenderFooterInput,
	renderFooterLines,
	SHED_MOVES,
} from "../src/degrade.ts";
import { selectFitting } from "../src/layout.ts";
import { formatTokens, sanitizeStatusText } from "../src/format.ts";

// ---------------------------------------------------------------- test seams
//
// Production passes pi-tui's visibleWidth / truncateToWidth and theme.fg. Bare
// node cannot resolve pi-tui, so we inject faithful stubs. `measure` strips SGR
// and the fg color tag then counts code points (every glyph we use is 1 column,
// verified against real pi-tui). `truncate` is width-correct: it never returns
// text whose measured width exceeds the budget — the same contract footer.ts
// relies on to avoid the pi-tui overflow crash.

const SGR = /\x1b\[[0-9;]*m/g;

/** Deterministic color → RGB so assertions can grep for a color's SGR. */
const COLOR_RGB: Record<string, [number, number, number]> = {
	accent: [11, 11, 11],
	dim: [22, 22, 22],
	success: [33, 33, 33],
	warning: [44, 44, 44],
	error: [55, 55, 55],
};

function measure(s: string): number {
	return [...s.replace(SGR, "")].length;
}

function sgrOf(color: string): string {
	const [r, g, b] = COLOR_RGB[color] ?? [99, 99, 99];
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Colorizer that emits real SGR (like production theme.fg). */
function fg(color: string, text: string): string {
	return `${sgrOf(color)}${text}\x1b[39m`;
}

function* tokens(s: string): Generator<{ t: string; vis: number }> {
	const re = /\x1b\[[0-9;]*m/gu;
	let i = 0;
	while (i < s.length) {
		re.lastIndex = i;
		const m = re.exec(s);
		if (m && m.index === i) {
			yield { t: m[0], vis: 0 };
			i += m[0].length;
			continue;
		}
		const cp = String.fromCodePoint(s.codePointAt(i)!);
		yield { t: cp, vis: 1 };
		i += cp.length;
	}
}

function truncate(text: string, w: number, suffix = ""): string {
	if (w <= 0) return "";
	if (measure(text) <= w) return text;
	const budget = Math.max(0, w - measure(suffix));
	let out = "";
	let visible = 0;
	for (const { t, vis } of tokens(text)) {
		if (vis > 0 && visible >= budget) break;
		out += t;
		visible += vis;
	}
	return out + suffix;
}

const DEPS = { measure, truncate, fg };

// --------------------------------------------------------------- test inputs

const FULL_SEGS: LeftSeg[] = [
	{ key: "model", text: "claude-sonnet-4-5", hex: "#ca9ee6", icon: "\u{F035B}" },
	{ key: "effort", text: "high", hex: "#eebebe", icon: "\u{F09D1}" },
	{ key: "folder", text: "pi-ext-stuff", hex: "#99d1db", icon: "\u{F024B}" },
	{ key: "branch", text: "main", hex: "#e5c890", icon: "\u{F0641}" },
];

function rightInput(over: Partial<RenderFooterInput["right"]> = {}): RenderFooterInput["right"] {
	return {
		cacheRate: over.cacheRate !== undefined ? over.cacheRate : 66.4,
		usage:
			"usage" in over
				? over.usage
				: { percent: 42, tokens: 80600, window: 192000 },
	};
}

function baseInput(over: Partial<RenderFooterInput> = {}): RenderFooterInput {
	return {
		width: over.width ?? 120,
		pad: over.pad ?? 1,
		left: { segments: over.left?.segments ?? FULL_SEGS },
		right: over.right ?? rightInput(),
		statuses: over.statuses ?? new Map(),
	};
}

// --------------------------------------------------------------------- tests

test("right ladder widths strictly decrease (C0..C6)", () => {
	const forms = buildRightForms(rightInput(), measure, fg);
	const widths = forms.map((f) => f.width);
	// 7 canonical levels, each strictly narrower than the last, ending at 0.
	assert.equal(widths.length, 7);
	for (let i = 1; i < widths.length; i += 1) {
		assert.ok(widths[i]! < widths[i - 1]!, `level ${i} not narrower: ${widths}`);
	}
	assert.equal(widths[widths.length - 1], 0);
});

test("left ladder sheds powerline chrome before any text", () => {
	const forms = buildLeftForms({ segments: FULL_SEGS }, measure, fg);
	// [0] is the pill: contains both powerline caps.
	assert.ok(forms[0]!.text.includes("\uE0B6"), "pill must open with left cap");
	assert.ok(forms[0]!.text.includes("\uE0B4"), "pill must close with right cap");
	// [1] drops the chrome: plain `|`-joined, no caps.
	assert.ok(!forms[1]!.text.includes("\uE0B6"));
	assert.ok(forms[1]!.text.includes("|"), "plain form uses | separator");
	// model label survives every form (it is the last to go).
	for (const f of forms) {
		assert.ok(measure(f.text) > 0);
	}
	assert.ok(forms[forms.length - 1]!.text.includes("claude-sonnet-4-5"));
});

test("merged candidates are strictly decreasing and cover both sides", () => {
	const cands = buildFooterCandidates(
		buildLeftForms({ segments: FULL_SEGS }, measure, fg),
		buildRightForms(rightInput(), measure, fg),
	);
	let prev = Number.POSITIVE_INFINITY;
	for (const c of cands) {
		const total = c.left.width + c.right.width;
		assert.ok(total < prev, `not strictly decreasing at ${total}`);
		prev = total;
	}
	assert.ok(cands.length >= 2);
	assert.ok(SHED_MOVES.length > 0);
});

test("selectFitting is monotone: wider terminal never shows less", () => {
	const cands = buildFooterCandidates(
		buildLeftForms({ segments: FULL_SEGS }, measure, fg),
		buildRightForms(rightInput(), measure, fg),
	);
	let prev = -1; // chosen index at the previous (smaller) width
	for (let w = 0; w <= 200; w += 1) {
		const idx = selectFitting(cands, w, 2);
		// As width grows the chosen index must never increase (index 0 = richest).
		assert.ok(
			idx <= prev || prev === -1,
			`monotonicity violated at w=${w}: ${prev} -> ${idx}`,
		);
		if (idx >= 0) prev = idx;
	}
});

test("RED LINE: no rendered line ever exceeds width (fuzz)", () => {
	const segmentVariants: LeftSeg[][] = [
		FULL_SEGS,
		FULL_SEGS.filter((s) => s.key !== "branch"),
		FULL_SEGS.filter((s) => s.key !== "effort"),
		FULL_SEGS.filter((s) => s.key === "folder"),
		FULL_SEGS.filter((s) => s.key === "model"),
		[],
	];
	const rightVariants = [
		rightInput(),
		rightInput({ cacheRate: undefined }),
		rightInput({ usage: undefined }),
		rightInput({ cacheRate: undefined, usage: undefined }),
		rightInput({ usage: { percent: null, tokens: null, window: 192000 } }),
		rightInput({ usage: { percent: 99, tokens: 999999, window: 1000000 } }),
	];
	const statusVariants = [
		new Map<string, string>(),
		new Map([["other", "Indexing"]]),
		new Map([["other", "a\tb"], ["pi-safety", "auto"]]),
	];

	for (const pad of [0, 1]) {
		for (const segments of segmentVariants) {
			for (const right of rightVariants) {
				for (const statuses of statusVariants) {
					for (let width = 1; width <= 200; width += 1) {
						const lines = renderFooterLines(
							{ width, pad, left: { segments }, right, statuses },
							DEPS,
						);
						for (const line of lines) {
							const w = measure(line);
							assert.ok(
								w <= width,
								`line width ${w} > ${width} (pad=${pad}, segs=${segments.length})`,
							);
						}
					}
				}
			}
		}
	}
});

test("percent null renders '?' with dim, never a green success meter", () => {
	const lines = renderFooterLines(
		baseInput({
			right: { cacheRate: undefined, usage: { percent: null, tokens: null, window: 192000 } },
		}),
		DEPS,
	);
	const line = lines[0]!;
	assert.ok(line.includes("?"), "unknown percent must show '?'");
	assert.ok(!line.includes(sgrOf("success")), "null percent must not be painted success");
	assert.ok(line.includes(sgrOf("dim")), "null percent should be dim");
});

test("percent 0 renders success (distinct from null)", () => {
	const lines = renderFooterLines(
		baseInput({
			right: { cacheRate: undefined, usage: { percent: 0, tokens: 10, window: 192000 } },
			width: 120,
		}),
		DEPS,
	);
	assert.ok(lines[0]!.includes(sgrOf("success")));
	assert.ok(!lines[0]!.includes("?/"));
});

test("tab in a status is sanitized away", () => {
	const lines = renderFooterLines(
		baseInput({ statuses: new Map([["other", "a\t\tb  c"]]), width: 120 }),
		DEPS,
	);
	assert.equal(lines.length, 2, "status should occupy line 2");
	assert.ok(!lines[1]!.includes("\t"), "tabs must be folded to spaces");
	assert.ok(lines[1]!.includes("a b c"), "runs collapse to single spaces");
	assert.ok(measure(lines[1]!) <= 120);
});

test("pi-safety status is stripped from line 2", () => {
	const lines = renderFooterLines(
		baseInput({ statuses: new Map([["pi-safety", "Auto"], ["other", "Idx"]]) }),
		DEPS,
	);
	assert.equal(lines.length, 2);
	assert.ok(!lines[1]!.includes("Auto"), "pi-safety mode belongs to editor chrome");
	assert.ok(lines[1]!.includes("Idx"));
});

test("empty right side does not truncate the left", () => {
	const lines = renderFooterLines(
		baseInput({ right: { cacheRate: undefined, usage: undefined }, width: 120 }),
		DEPS,
	);
	assert.ok(!lines[0]!.includes("…"), "left must stay intact when right is empty");
	// pill survives at width 120 with a modest left
	assert.ok(lines[0]!.includes("\uE0B4"), "right cap intact => pill not sliced");
});

test("pill is never sliced: caps are both present or both absent", () => {
	for (let width = 1; width <= 200; width += 1) {
		const lines = renderFooterLines(baseInput({ width }), DEPS);
		const line = lines[0]!;
		const hasLeft = line.includes("\uE0B6");
		const hasRight = line.includes("\uE0B4");
		// A truncated pill (left cap without right cap) is the forbidden state.
		assert.ok(
			hasLeft === hasRight,
			`sliced pill at width=${width}: left=${hasLeft} right=${hasRight}`,
		);
	}
});

test("render is idempotent (no hidden state)", () => {
	const input = baseInput({ width: 70 });
	const a = renderFooterLines(input, DEPS);
	const b = renderFooterLines(input, DEPS);
	assert.deepEqual(a, b);
});

test("formatTokens width jump at 100k still renders within width", () => {
	// 99999 -> "100.0k" (6 cols), 100000 -> "100k" (4 cols): non-monotonic.
	assert.equal(measure(formatTokens(99999)), 6);
	assert.equal(measure(formatTokens(100000)), 4);
	for (const tokens of [99999, 100000]) {
		for (let width = 1; width <= 120; width += 1) {
			const lines = renderFooterLines(
				baseInput({
					width,
					right: { cacheRate: 50, usage: { percent: 50, tokens, window: 192000 } },
				}),
				DEPS,
			);
			for (const l of lines) assert.ok(measure(l) <= width);
		}
	}
});

test("formatTokens guards non-finite inputs", () => {
	assert.equal(formatTokens(Number.NaN), "0");
	assert.equal(formatTokens(Number.POSITIVE_INFINITY), "0");
	assert.equal(formatTokens(-5), "0");
	assert.ok(measure(formatTokens(Number.POSITIVE_INFINITY)) <= 2);
});

test("sanitizeStatusText folds tabs, newlines and space runs", () => {
	assert.equal(sanitizeStatusText("a\tb"), "a b");
	assert.equal(sanitizeStatusText("a\r\nb"), "a b");
	assert.equal(sanitizeStatusText("a    b"), "a b");
	assert.equal(sanitizeStatusText("  a  "), "a");
});

test("degenerate widths (0, 1, pad*2) never throw and stay in bounds", () => {
	for (const pad of [0, 1]) {
		for (const width of [0, 1, 2, pad * 2, pad * 2 + 1]) {
			const lines = renderFooterLines(baseInput({ width, pad }), DEPS);
			for (const l of lines) assert.ok(measure(l) <= Math.max(0, width));
		}
	}
});
