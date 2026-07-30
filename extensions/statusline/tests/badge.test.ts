import assert from "node:assert/strict";
import test from "node:test";
import { badgeColorFor, makeModeBadgeDecorator, parseTruecolor } from "../src/badge.ts";

test("parses truecolor foreground sequences", () => {
	assert.deepEqual(parseTruecolor("\x1b[38;2;229;200;144m"), [229, 200, 144]);
	assert.deepEqual(parseTruecolor("\x1b[48;2;10;20;30m"), [10, 20, 30]);
});

test("returns null for non-truecolor sequences", () => {
	assert.equal(parseTruecolor("\x1b[33m"), null);
	assert.equal(parseTruecolor("\x1b[38;5;220m"), null);
	assert.equal(parseTruecolor(""), null);
});

test("decorates with warning background and black text", () => {
	const decorate = makeModeBadgeDecorator("\x1b[38;2;229;200;144m");
	assert.equal(
		decorate(" Auto "),
		"\x1b[48;2;229;200;144m\x1b[30m Auto \x1b[39m\x1b[49m",
	);
});

test("falls back to inverse video without truecolor data", () => {
	for (const ansi of [undefined, "\x1b[33m", "\x1b[38;5;220m"]) {
		const decorate = makeModeBadgeDecorator(ansi);
		assert.equal(decorate(" Auto "), "\x1b[7m Auto \x1b[27m");
	}
});

test("YOLO badge escalates to error color; other modes stay warning", () => {
	assert.equal(badgeColorFor("YOLO"), "error");
	assert.equal(badgeColorFor("Auto"), "warning");
	assert.equal(badgeColorFor("Plan"), "warning");
});
