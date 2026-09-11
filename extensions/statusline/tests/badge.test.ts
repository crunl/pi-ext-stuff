import assert from "node:assert/strict";
import test from "node:test";
import {
	BADGE_CAP_WIDTH,
	badgeColorFor,
	contrastTextFor,
	makeModeBadgeDecorator,
	parseTruecolor,
	PL_LEFT,
	PL_RIGHT,
} from "../src/badge.ts";

test("parses truecolor foreground sequences", () => {
	assert.deepEqual(parseTruecolor("\x1b[38;2;229;200;144m"), [229, 200, 144]);
	assert.deepEqual(parseTruecolor("\x1b[48;2;10;20;30m"), [10, 20, 30]);
});

test("returns null for non-truecolor sequences", () => {
	assert.equal(parseTruecolor("\x1b[33m"), null);
	assert.equal(parseTruecolor("\x1b[38;5;220m"), null);
	assert.equal(parseTruecolor(""), null);
});

test("uses black text on light backgrounds and white on dark", () => {
	// Catppuccin mocha red (light) -> black text
	assert.equal(contrastTextFor([231, 130, 132]), "\x1b[30m");
	// Catppuccin latte red (dark) -> white text
	assert.equal(contrastTextFor([210, 15, 57]), "\x1b[97m");
	// Threshold boundary
	assert.equal(contrastTextFor([128, 128, 128]), "\x1b[30m");
	assert.equal(contrastTextFor([127, 127, 127]), "\x1b[97m");
});

test("decorates as a powerline pill with warning background", () => {
	const decorate = makeModeBadgeDecorator("\x1b[38;2;229;200;144m");
	assert.equal(
		decorate("Auto"),
		"\x1b[38;2;229;200;144m" +
			PL_LEFT +
			"\x1b[39m" +
			"\x1b[48;2;229;200;144m\x1b[30mAuto\x1b[39m\x1b[49m" +
			"\x1b[38;2;229;200;144m" +
			PL_RIGHT +
			"\x1b[39m",
	);
});

test("decorates dark backgrounds with white text", () => {
	const decorate = makeModeBadgeDecorator("\x1b[38;2;210;15;57m");
	const out = decorate("YOLO");
	assert.ok(out.includes("\x1b[48;2;210;15;57m\x1b[97mYOLO\x1b[39m\x1b[49m"));
	assert.ok(out.startsWith("\x1b[38;2;210;15;57m" + PL_LEFT));
	assert.ok(out.endsWith(PL_RIGHT + "\x1b[39m"));
});

test("falls back to inverse video without truecolor data", () => {
	for (const ansi of [undefined, "\x1b[33m", "\x1b[38;5;220m"]) {
		const decorate = makeModeBadgeDecorator(ansi);
		assert.equal(decorate("Auto"), `\x1b[7m${PL_LEFT}Auto${PL_RIGHT}\x1b[27m`);
	}
});

test("badge color passes the published severity through", () => {
	assert.equal(badgeColorFor("error"), "error");
	assert.equal(badgeColorFor("warning"), "warning");
});

test("caps add two visible columns around the label", () => {
	assert.equal(BADGE_CAP_WIDTH, 2);
	assert.equal(PL_LEFT.length, 1);
	assert.equal(PL_RIGHT.length, 1);
});

test("inset style is width-neutral (no caps)", () => {
	const decorate = makeModeBadgeDecorator("\x1b[38;2;229;200;144m", "inset");
	assert.equal(decorate("Auto"), "\x1b[48;2;229;200;144m\x1b[30mAuto\x1b[39m\x1b[49m");
});

test("inset falls back to inverse without truecolor", () => {
	const decorate = makeModeBadgeDecorator(undefined, "inset");
	assert.equal(decorate("Auto"), "\x1b[7mAuto\x1b[27m");
});