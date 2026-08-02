import assert from "node:assert/strict";
import test from "node:test";
import { contrastTextFor, makeModeBadgeDecorator } from "../src/badge.ts";

test("uses black text on light backgrounds and white on dark", () => {
	// Gold (light) -> black text
	assert.equal(contrastTextFor([255, 215, 0]), "\x1b[30m");
	// Dark red (dark) -> white text
	assert.equal(contrastTextFor([139, 0, 0]), "\x1b[97m");
	// Threshold boundary
	assert.equal(contrastTextFor([128, 128, 128]), "\x1b[30m");
	assert.equal(contrastTextFor([127, 127, 127]), "\x1b[97m");
});

test("warning badge: golden background with black text", () => {
	const decorate = makeModeBadgeDecorator("warning");
	assert.equal(
		decorate(" Auto "),
		"\x1b[48;2;255;215;0m\x1b[30m Auto \x1b[39m\x1b[49m",
	);
});

test("error badge: dark red background with white text", () => {
	const decorate = makeModeBadgeDecorator("error");
	assert.equal(
		decorate(" YOLO "),
		"\x1b[48;2;139;0;0m\x1b[97m YOLO \x1b[39m\x1b[49m",
	);
});
