/**
 * Width-aware spans + fit selection for the footer.
 *
 * Pure and zero-pi: the width measurer and the truncator are *injected* by
 * the caller (footer passes pi-tui's `visibleWidth` / `truncateToWidth`;
 * tests pass stubs). This is what lets the whole degradation ladder be
 * unit-tested under bare `node --test` without a Pi runtime.
 *
 * The core idea is the `Span`: a string paired with its *measured* visible
 * width. Width is computed once, from the plain text, at construction. Every
 * later operation (`paint`, `join`) only ever adds zero-width SGR or sums
 * existing widths — so the colored form can never drift from its width. That
 * kills the old `rightPlainParts` / `rightColoredParts` double-track, where
 * the two arrays had to stay character-aligned or the fit check lied.
 */

/** A string plus its visible width in columns. `width` is the only truth. */
export interface Span {
	readonly text: string; // may contain SGR sequences
	readonly width: number; // visible columns == measure(text) with SGR ignored
}

export const EMPTY_SPAN: Span = { text: "", width: 0 };

/** Injected width measurer (production: pi-tui `visibleWidth`). */
export type Measure = (plain: string) => number;

/**
 * Build a span from *plain* text, measuring once. This is the only place a
 * width is ever computed from a string; downstream ops just add. Prefer this
 * over `coloredSpan` unless the text is already colored (e.g. a powerline
 * chain) and you must pass its SGR-free width.
 */
export function span(text: string, measure: Measure): Span {
	return text === "" ? EMPTY_SPAN : { text, width: measure(text) };
}

/**
 * Box an *already colored* string together with its plain width. Callers that
 * build colored text directly (e.g. the powerline chain) use this; the width
 * must be `measure(stripAnsi(text))`, never `text.length`.
 */
export function coloredSpan(text: string, width: number): Span {
	return width === 0 && text === "" ? EMPTY_SPAN : { text, width };
}

/**
 * Wrap a span's text with a zero-width decorator (an SGR painter). The width
 * is carried through untouched — painting never changes how many columns the
 * text occupies. `wrap` MUST only add SGR (theme.fg / truecolor prefix+reset).
 */
export function paint(sp: Span, wrap: (s: string) => string): Span {
	if (sp === EMPTY_SPAN || sp.width === 0) return sp;
	return { text: wrap(sp.text), width: sp.width };
}

/**
 * Join non-empty spans with a separator span. Widths add; empty parts are
 * dropped so a missing segment never contributes a dangling separator.
 */
export function joinSpans(parts: readonly Span[], sep: Span): Span {
	const kept = parts.filter((p) => p.width > 0);
	if (kept.length === 0) return EMPTY_SPAN;
	let text = kept[0]!.text;
	let width = kept[0]!.width;
	for (let i = 1; i < kept.length; i += 1) {
		text += sep.text + kept[i]!.text;
		width += sep.width + kept[i]!.width;
	}
	return { text, width };
}

/** One candidate footer line: a left span and a right span. */
export interface Candidate {
	readonly left: Span;
	readonly right: Span;
}

/**
 * Pick the richest candidate that still fits.
 *
 * `candidates` MUST be ordered richest-first with *strictly non-increasing*
 * total width (buildFooterCandidates guarantees this). Under that invariant
 * the chosen index is a monotone non-increasing function of `innerWidth`:
 * a wider terminal can only ever unlock an earlier (richer) candidate, never
 * skip one — so the footer cannot oscillate between frames.
 *
 * A candidate with an empty right span fits on `left.width` alone (no
 * minPadding reserved) — an empty right side must never push the left out.
 *
 * Returns the chosen index, or -1 when even the leanest candidate overflows
 * (the caller then truncates that candidate's left span as a last resort).
 */
export function selectFitting(
	candidates: readonly Candidate[],
	innerWidth: number,
	minPadding: number,
): number {
	for (let i = 0; i < candidates.length; i += 1) {
		const c = candidates[i]!;
		const need =
			c.left.width + (c.right.width > 0 ? minPadding + c.right.width : 0);
		if (need <= innerWidth) return i;
	}
	return -1;
}

/**
 * Drop candidates that are not strictly narrower than their predecessor.
 *
 * The shed plan can produce duplicate or non-narrowing steps (e.g. a side is
 * already exhausted, or two data-driven variants coincide). Such a step offers
 * no new width budget but strictly less information, so it would never be
 * selected — removing it keeps the width sequence strictly decreasing, which
 * is exactly what makes selectFitting monotone.
 */
export function dedupeNarrowing(candidates: readonly Candidate[]): Candidate[] {
	const out: Candidate[] = [];
	let prev = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const total = c.left.width + c.right.width;
		if (total < prev) {
			out.push(c);
			prev = total;
		}
	}
	return out;
}
