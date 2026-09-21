import assert from "node:assert/strict";
import test from "node:test";
import { boxEditorLines } from "../src/box-editor.ts";

const W = 20; // inner width

function plainBorder(width: number): string {
	return "─".repeat(width);
}

function content(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - text.length));
}

test("wraps top, content, and bottom with corners and rails", () => {
	const lines = [
		plainBorder(W),
		content("hello", W),
		plainBorder(W),
	];
	const boxed = boxEditorLines(lines, W);
	assert.equal(boxed.length, 3);
	assert.equal(boxed[0], `╭${plainBorder(W)}╮`);
	assert.equal(boxed[1], `│${content("hello", W)}│`);
	assert.equal(boxed[2], `╰${plainBorder(W)}╯`);
});

test("leaves autocomplete rows after the bottom border unboxed", () => {
	const lines = [
		plainBorder(W),
		content("cmd", W),
		plainBorder(W),
		content("/help", W),
	];
	const boxed = boxEditorLines(lines, W);
	assert.equal(boxed[3], content("/help", W));
	assert.ok(!boxed[3]!.includes("│"));
});

test("scroll borders still receive corners", () => {
	const scroll = `─── ↑ 3 more ${"─".repeat(W - 14)}`;
	const lines = [scroll, content("x", W), plainBorder(W)];
	const boxed = boxEditorLines(lines, W);
	assert.ok(boxed[0]!.startsWith("╭"));
	assert.ok(boxed[0]!.endsWith("╮"));
});

test("applies chrome color function to corners and rails", () => {
	const paint = (s: string) => `<${s}>`;
	const boxed = boxEditorLines([plainBorder(W), content("a", W), plainBorder(W)], W, paint);
	assert.equal(boxed[0], `<╭>${plainBorder(W)}<╮>`);
	assert.equal(boxed[1], `<│>${content("a", W)}<│>`);
	assert.equal(boxed[2], `<╰>${plainBorder(W)}<╯>`);
});

test("returns input untouched when there is no border", () => {
	const lines = [content("just text", W)];
	assert.deepEqual(boxEditorLines(lines, W), lines);
});

test("boxes using known indices after labels destroy pure-border detection", () => {
	const labeledTop = "──Auto" + "─".repeat(W - 6);
	const labeledBottom = "── model " + "─".repeat(W - 9);
	const lines = [labeledTop, content("hi", W), labeledBottom];
	// Auto-detect fails (labels contain letters)…
	assert.deepEqual(boxEditorLines(lines, W), lines);
	// …but known indices work.
	const boxed = boxEditorLines(lines, W, (s) => s, { topIdx: 0, bottomIdx: 2 });
	assert.equal(boxed[0], `╭${labeledTop}╮`);
	assert.equal(boxed[1], `│${content("hi", W)}│`);
	assert.equal(boxed[2], `╰${labeledBottom}╯`);
});

test("handles empty input and non-positive width", () => {
	assert.deepEqual(boxEditorLines([], W), []);
	assert.deepEqual(boxEditorLines([content("a", 4)], 0), [content("a", 4)]);
});
