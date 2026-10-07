import assert from "node:assert/strict";
import test from "node:test";
import { parseTruecolor } from "../../../packages/shared-tool-presentation/src/badge.ts";
import { resolveModelInfo } from "../src/model-info.ts";
import {
	effortColor,
	isLightThemeFrom,
	PALETTE_DARK,
	PALETTE_LIGHT,
	paletteForLight,
	truecolorFg,
} from "../src/palette.ts";

test("truecolorFg emits SGR parseable by badge.parseTruecolor", () => {
	const hexes = [
		...Object.values(PALETTE_DARK.fixed),
		...Object.values(PALETTE_DARK.effort),
		...Object.values(PALETTE_LIGHT.fixed),
		...Object.values(PALETTE_LIGHT.effort),
	];
	for (const hex of hexes) {
		const rgb = parseTruecolor(truecolorFg(hex));
		assert.ok(rgb, `should parse ${hex}`);
	}
});

test("dark palette uses Catppuccin Frappé accents", () => {
	assert.equal(PALETTE_DARK.fixed.model, "#ca9ee6");
	assert.equal(PALETTE_DARK.fixed.folder, "#99d1db");
	assert.equal(PALETTE_DARK.fixed.git, "#e5c890");
	assert.equal(PALETTE_DARK.effort.minimal, "#a6d189");
	assert.equal(PALETTE_DARK.effort.low, "#8caaee");
	assert.equal(PALETTE_DARK.effort.medium, "#f2d5cf");
	assert.equal(PALETTE_DARK.effort.high, "#eebebe");
	assert.equal(PALETTE_DARK.effort.xhigh, "#ef9f76");
	assert.equal(PALETTE_DARK.effort.max, "#f4b8e4");
});

test("light palette uses pressed-dark Catppuccin hues", () => {
	assert.equal(PALETTE_LIGHT.fixed.model, "#8839ef");
	assert.equal(PALETTE_LIGHT.fixed.folder, "#00787f");
	assert.equal(PALETTE_LIGHT.fixed.git, "#a25c00");
	assert.equal(PALETTE_LIGHT.effort.minimal, "#148002");
	assert.equal(PALETTE_LIGHT.effort.low, "#0761ef");
	assert.equal(PALETTE_LIGHT.effort.medium, "#4564d5");
	assert.equal(PALETTE_LIGHT.effort.high, "#ae4f51");
	assert.equal(PALETTE_LIGHT.effort.xhigh, "#ca3700");
	assert.equal(PALETTE_LIGHT.effort.max, "#b03f95");
});

test("effort hues never collide with fixed slots in either palette", () => {
	for (const pal of [PALETTE_DARK, PALETTE_LIGHT]) {
		const fixed = new Set(Object.values(pal.fixed));
		for (const [level, hex] of Object.entries(pal.effort)) {
			assert.equal(fixed.has(hex), false, `${level} ${hex} overlaps fixed`);
		}
	}
});

test("paletteForLight switches sets", () => {
	assert.equal(paletteForLight(false), PALETTE_DARK);
	assert.equal(paletteForLight(true), PALETTE_LIGHT);
});

test("isLightThemeFrom uses userMessageBg luminance", () => {
	// latte mantle ~ #e6e9ef
	const latte = {
		getBgAnsi: () => "\x1b[48;2;230;233;239m",
	};
	// frappe mantle ~ #292c3c
	const frappe = {
		getBgAnsi: () => "\x1b[48;2;41;44;60m",
	};
	assert.equal(isLightThemeFrom(latte), true);
	assert.equal(isLightThemeFrom(frappe), false);
	assert.equal(isLightThemeFrom(undefined), false);
	assert.equal(isLightThemeFrom({}), false);
});

test("effortColor maps levels and falls back to medium", () => {
	const pal = PALETTE_DARK;
	assert.equal(effortColor("low", pal), pal.effort.low);
	assert.equal(effortColor("max", pal), pal.effort.max);
	assert.equal(effortColor("nope", pal), pal.effort.medium);
	assert.equal(effortColor(undefined, pal), pal.effort.medium);
});

test("resolveModelInfo hides effort when off or non-reasoning", () => {
	assert.equal(
		resolveModelInfo({ modelId: "m", reasoning: true, thinkingLevel: "off" }).effort,
		undefined,
	);
	assert.equal(
		resolveModelInfo({ modelId: "m", reasoning: false, thinkingLevel: "high" }).effort,
		undefined,
	);
	assert.equal(
		resolveModelInfo({ modelId: "m", reasoning: true, thinkingLevel: undefined }).effort,
		undefined,
	);
	assert.equal(
		resolveModelInfo({ modelId: "m", reasoning: true, thinkingLevel: "high" }).effort,
		"high",
	);
	assert.equal(
		resolveModelInfo({ modelId: "m", reasoning: true, thinkingLevel: "high" }).modelId,
		"m",
	);
});

// ---------------------------------------------------------------------------
// Contrast regression tests (WCAG 2.1, computed dependency-free).
//
// The pill renders each slot as a background block with auto black/white text
// (contrastTextFor, YIQ threshold 128); the degraded `|` form renders the same
// hex as foreground text. Both forms must stay readable on their theme base:
//   - text (1.4.3): ≥ 4.5 for the label on its block and for the `|` fg on base
//   - block vs base boundary (1.4.11 non-text): ≥ 3.0
// Reference bases: latte #eff1f5, frappe #303446.

function channelLum(pair: string): number {
	const c = Number.parseInt(pair, 16) / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relLum(hex: string): number {
	const r = channelLum(hex.slice(1, 3));
	const g = channelLum(hex.slice(3, 5));
	const b = channelLum(hex.slice(5, 7));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const la = relLum(a);
	const lb = relLum(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

function yiqLuma(hex: string): number {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return (299 * r + 587 * g + 114 * b) / 1000;
}

test("light slots pass text contrast on the latte base with white pill text", () => {
	const base = "#eff1f5";
	const slots = [...Object.values(PALETTE_LIGHT.fixed), ...Object.values(PALETTE_LIGHT.effort)];
	for (const hex of slots) {
		// `|` foreground form: slot color as text on the base.
		assert.ok(
			contrastRatio(hex, base) >= 4.5,
			`${hex} as foreground on ${base}: ${contrastRatio(hex, base).toFixed(2)}`,
		);
		// Pill form: the pressed-dark slot must take white text under the
		// existing YIQ-128 rule, and white-on-block must pass 4.5.
		assert.ok(yiqLuma(hex) < 128, `${hex} must stay dark enough for white pill text`);
		assert.ok(
			contrastRatio("#ffffff", hex) >= 4.5,
			`white text on ${hex}: ${contrastRatio("#ffffff", hex).toFixed(2)}`,
		);
	}
});

test("dark slots pass text contrast on the frappe base with black pill text", () => {
	const base = "#303446";
	const slots = [...Object.values(PALETTE_DARK.fixed), ...Object.values(PALETTE_DARK.effort)];
	for (const hex of slots) {
		assert.ok(yiqLuma(hex) >= 128, `${hex} must stay light enough for black pill text`);
		assert.ok(
			contrastRatio("#000000", hex) >= 4.5,
			`black text on ${hex}: ${contrastRatio("#000000", hex).toFixed(2)}`,
		);
		assert.ok(
			contrastRatio(hex, base) >= 3.0,
			`${hex} block vs ${base}: ${contrastRatio(hex, base).toFixed(2)}`,
		);
	}
});
