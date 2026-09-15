import assert from "node:assert/strict";
import test from "node:test";
import { parseTruecolor } from "../src/badge.ts";
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
	assert.equal(PALETTE_DARK.fixed.model, "#e78284");
	assert.equal(PALETTE_DARK.fixed.folder, "#ef9f76");
	assert.equal(PALETTE_DARK.fixed.git, "#e5c890");
	assert.equal(PALETTE_DARK.fixed.session, "#ca9ee6");
	assert.equal(PALETTE_DARK.effort.minimal, "#a6d189");
	assert.equal(PALETTE_DARK.effort.medium, "#8caaee");
	assert.equal(PALETTE_DARK.effort.max, "#f4b8e4");
});

test("light palette uses Catppuccin Latte accents", () => {
	assert.equal(PALETTE_LIGHT.fixed.model, "#d20f39");
	assert.equal(PALETTE_LIGHT.fixed.folder, "#fe640b");
	assert.equal(PALETTE_LIGHT.fixed.git, "#df8e1d");
	assert.equal(PALETTE_LIGHT.fixed.session, "#8839ef");
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
